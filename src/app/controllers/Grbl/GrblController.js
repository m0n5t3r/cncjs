import _ from 'lodash';
import ExpressionEvaluator from 'expr-eval';
import SerialPort from 'serialport';
import ensureArray from '../../lib/ensure-array';
import EventTrigger from '../../lib/event-trigger';
import Feeder from '../../lib/feeder';
import log from '../../lib/log';
import Sender, { SP_TYPE_CHAR_COUNTING } from '../../lib/sender';
import Workflow, {
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_RUNNING
} from '../../lib/workflow';
import config from '../../services/configstore';
import monitor from '../../services/monitor';
import taskRunner from '../../services/taskrunner';
import store from '../../store';
import Grbl from './Grbl';
import {
    GRBL,
    GRBL_ACTIVE_STATE_RUN,
    GRBL_REALTIME_COMMANDS,
    GRBL_ALARMS,
    GRBL_ERRORS,
    GRBL_SETTINGS
} from './constants';

const noop = _.noop;

const dbg = (...args) => {
    log.raw.apply(log, ['silly'].concat(args));
};

const reExpressionContext = new RegExp(/\[[^\]]+\]/g);

class GrblController {
    type = GRBL;

    // Connections
    connections = {};

    // SerialPort
    options = {
        port: '',
        baudrate: 115200
    };
    serialport = null;
    serialportListener = {
        data: (data) => {
            this.grbl.parse('' + data);
            dbg(`[Grbl] < ${data}`);
        },
        disconnect: (err) => {
            this.ready = false;
            if (err) {
                log.warn(`[Grbl] Disconnected from serial port "${this.options.port}":`, err);
            }

            this.close();
        },
        error: (err) => {
            this.ready = false;
            if (err) {
                log.error(`[Grbl] Unexpected error while reading/writing serial port "${this.options.port}":`, err);
            }
        }
    };

    // Grbl
    grbl = null;
    ready = false;
    state = {};
    queryTimer = null;
    actionMask = {
        queryParserState: {
            state: false, // wait for a message containing the current G-code parser modal state
            reply: false // wait for an `ok` or `error` response
        },
        queryStatusReport: false,

        // Respond to user input
        replyParserState: false, // $G
        replyStatusReport: false // ?
    };
    actionTime = {
        queryParserState: 0,
        queryStatusReport: 0
    };

    // Event Trigger
    event = null;

    // Feeder
    feeder = null;

    // Sender
    sender = null;

    // Workflow
    workflow = null;

    translateWithContext = (gcode, context = {}) => {
        if (typeof gcode !== 'string') {
            log.error(`[Grbl] No valid G-code string: gcode=${gcode}`);
            return '';
        }

        const { Parser } = ExpressionEvaluator;

        // Work position
        const { x: posx, y: posy, z: posz, a: posa, b: posb, c: posc } = this.grbl.getWorkPosition();

        // Context
        context = {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
            zmin: 0,
            zmax: 0,
            ...context,

            // Work position cannot be overridden by context
            posx,
            posy,
            posz,
            posa,
            posb,
            posc
        };

        try {
            gcode = gcode.replace(reExpressionContext, (match) => {
                const expr = match.slice(1, -1);
                return Parser.evaluate(expr, context);
            });
        } catch (e) {
            log.error('[Grbl] translateWithContext:', e);
        }

        return gcode;
    };

    constructor(port, options) {
        const { baudrate } = { ...options };

        this.options = {
            ...this.options,
            port: port,
            baudrate: baudrate
        };

        // Event Trigger
        this.event = new EventTrigger((event, trigger, commands) => {
            log.debug(`[Grbl] EventTrigger: event="${event}", trigger="${trigger}", commands="${commands}"`);
            if (trigger === 'system') {
                taskRunner.run(commands);
            } else {
                this.command(null, 'gcode', commands);
            }
        });

        // Feeder
        this.feeder = new Feeder();
        this.feeder.on('data', (command = '', context = {}) => {
            if (this.isClose()) {
                log.error(`[Grbl] Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.grbl.isAlarm()) {
                // Feeder
                this.feeder.clear();
                log.warn('[Grbl] Stopped sending G-code commands in Alarm mode');
                return;
            }

            let line = String(command).trim();
            if (line.length === 0) {
                return;
            }

            // Example
            // "G0 X[posx - 8] Y[ymax]" -> "G0 X2 Y50"
            line = this.translateWithContext(line, context);

            this.emitAll('serialport:write', line);

            this.serialport.write(line + '\n');
            dbg(`[Grbl] > ${line}`);
        });

        // Sender
        this.sender = new Sender(SP_TYPE_CHAR_COUNTING, {
            // Deduct the length of periodic commands ('$G\n', '?') to prevent from buffer overrun
            bufferSize: (128 - 8) // The default buffer size is 128 bytes
        });
        this.sender.on('data', (gcode = '', context = {}) => {
            if (this.isClose()) {
                log.error(`[Grbl] Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.workflow.state !== WORKFLOW_STATE_RUNNING) {
                log.error(`[Grbl] Unexpected workflow state: ${this.workflow.state}`);
                return;
            }

            gcode = ('' + gcode).trim();
            if (gcode.length > 0) {
                this.serialport.write(gcode + '\n');
                dbg(`[Grbl] > ${gcode}`);
            }
        });

        // Workflow
        this.workflow = new Workflow();
        this.workflow.on('start', () => {
            this.sender.rewind();
        });
        this.workflow.on('stop', () => {
            this.sender.rewind();
        });
        this.workflow.on('resume', () => {
            this.sender.next();
        });

        // Grbl
        this.grbl = new Grbl();

        this.grbl.on('raw', noop);

        this.grbl.on('status', (res) => {
            this.actionMask.queryStatusReport = false;

            // Do not change buffer size during gcode sending (#133)
            if (this.workflow.state === WORKFLOW_STATE_IDLE && this.sender.sp.dataLength === 0) {
                // Check if Grbl reported the rx buffer (#115)
                if (res && res.buf && res.buf.rx) {
                    const rx = Number(res.buf.rx) || 0;
                    // Deduct the length of periodic commands ('$G\n', '?') to prevent from buffer overrun
                    const bufferSize = (rx - 8);
                    if (bufferSize > this.sender.sp.bufferSize) {
                        this.sender.sp.bufferSize = bufferSize;
                    }
                }
            }

            if (this.actionMask.replyStatusReport) {
                this.actionMask.replyStatusReport = false;
                this.emitAll('serialport:read', res.raw);
            }
        });

        this.grbl.on('ok', (res) => {
            if (this.actionMask.queryParserState.reply) {
                if (this.actionMask.replyParserState) {
                    this.actionMask.replyParserState = false;
                    this.emitAll('serialport:read', res.raw);
                }
                this.actionMask.queryParserState.reply = false;
                return;
            }

            // Sender
            if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                this.sender.ack();
                this.sender.next();
                return;
            }

            this.emitAll('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.grbl.on('error', (res) => {
            const code = Number(res.message) || undefined;
            const error = _.find(GRBL_ERRORS, { code: code });

            // Sender
            if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                const { lines, received } = this.sender.state;
                const line = lines[received] || '';

                this.emitAll('serialport:read', `> ${line.trim()} (line=${received + 1})`);
                if (error) {
                    // Grbl v1.1
                    this.emitAll('serialport:read', `error:${code} (${error.message})`);
                } else {
                    // Grbl v0.9
                    this.emitAll('serialport:read', res.raw);
                }

                this.sender.ack();
                this.sender.next();
                return;
            }

            if (error) {
                // Grbl v1.1
                this.emitAll('serialport:read', `error:${code} (${error.message})`);
            } else {
                // Grbl v0.9
                this.emitAll('serialport:read', res.raw);
            }

            // Feeder
            this.feeder.next();
        });

        this.grbl.on('alarm', (res) => {
            const code = Number(res.message) || undefined;
            const alarm = _.find(GRBL_ALARMS, { code: code });

            if (alarm) {
                // Grbl v1.1
                this.emitAll('serialport:read', `ALARM:${code} (${alarm.message})`);
            } else {
                // Grbl v0.9
                this.emitAll('serialport:read', res.raw);
            }
        });

        this.grbl.on('parserstate', (res) => {
            this.actionMask.queryParserState.state = false;
            this.actionMask.queryParserState.reply = true;

            if (this.actionMask.replyParserState) {
                this.emitAll('serialport:read', res.raw);
            }
        });

        this.grbl.on('parameters', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.grbl.on('feedback', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.grbl.on('settings', (res) => {
            const setting = _.find(GRBL_SETTINGS, { setting: res.setting });

            if (!res.message && setting) {
                // Grbl v1.1
                this.emitAll('serialport:read', `${res.setting}=${res.value} (${setting.message}, ${setting.units})`);
            } else {
                // Grbl v0.9
                this.emitAll('serialport:read', res.raw);
            }
        });

        this.grbl.on('startup', (res) => {
            this.emitAll('serialport:read', res.raw);

            // Set ready flag to true when a Grbl start up message has arrived
            this.ready = true;

            // The start up message always prints upon startup, after a reset, or at program end.
            // Setting the initial state when Grbl has completed re-initializing all systems.

            this.clearActionValues();
        });

        this.grbl.on('others', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        const queryStatusReport = () => {
            const now = new Date().getTime();
            const lastQueryTime = this.actionTime.queryStatusReport;

            if (lastQueryTime > 0) {
                const timespan = Math.abs(now - lastQueryTime);
                const toleranceTime = 5000; // 5 seconds

                // Check if it has not been updated for a long time
                if (timespan >= toleranceTime) {
                    log.debug(`[Grbl] Continue status report query: timespan=${timespan}ms`);
                    this.actionMask.queryStatusReport = false;
                }
            }

            if (this.actionMask.queryStatusReport) {
                return;
            }

            if (this.isOpen()) {
                this.actionMask.queryStatusReport = true;
                this.actionTime.queryStatusReport = now;
                this.serialport.write('?');
            }
        };

        const queryParserState = _.throttle(() => {
            const now = new Date().getTime();
            const lastQueryTime = this.actionTime.queryParserState;

            if (lastQueryTime > 0) {
                const timespan = Math.abs(now - lastQueryTime);
                const toleranceTime = 10000; // 10 seconds

                // Check if it has not been updated for a long time
                if (timespan >= toleranceTime) {
                    log.debug(`[Grbl] Continue parser state query: timespan=${timespan}ms`);
                    this.actionMask.queryParserState.state = false;
                    this.actionMask.queryParserState.reply = false;
                }
            }

            if (this.actionMask.queryParserState.state || this.actionMask.queryParserState.reply) {
                return;
            }

            if (this.isOpen()) {
                this.actionMask.queryParserState.state = true;
                this.actionMask.queryParserState.reply = false;
                this.actionTime.queryParserState = now;
                this.serialport.write('$G\n');
            }
        }, 500);

        this.queryTimer = setInterval(() => {
            if (this.isClose()) {
                // Serial port is closed
                return;
            }

            // Feeder
            if (this.feeder.peek()) {
                this.emitAll('feeder:status', this.feeder.toJSON());
            }

            // Sender
            if (this.sender.peek()) {
                this.emitAll('sender:status', this.sender.toJSON());
            }

            // Grbl state
            if (this.state !== this.grbl.state) {
                this.state = this.grbl.state;
                this.emitAll('Grbl:state', this.state);
            }

            // Wait for the bootloader to complete before sending commands
            if (!(this.ready)) {
                // Not ready yet
                return;
            }

            // ? - Status Report
            queryStatusReport();

            // $G - Parser State
            queryParserState();
        }, 250);
    }
    clearActionValues() {
        this.actionMask.queryParserState.state = false;
        this.actionMask.queryParserState.reply = false;
        this.actionMask.queryStatusReport = false;
        this.actionMask.replyParserState = false;
        this.actionMask.replyStatusReport = false;
        this.actionTime.queryParserState = 0;
        this.actionTime.queryStatusReport = 0;
    }
    destroy() {
        this.connections = {};

        if (this.serialport) {
            this.serialport = null;
        }

        if (this.event) {
            this.event = null;
        }

        if (this.feeder) {
            this.feeder = null;
        }

        if (this.sender) {
            this.sender = null;
        }

        if (this.workflow) {
            this.workflow = null;
        }

        if (this.queryTimer) {
            clearInterval(this.queryTimer);
            this.queryTimer = null;
        }

        if (this.grbl) {
            this.grbl.removeAllListeners();
            this.grbl = null;
        }
    }
    get status() {
        return {
            port: this.options.port,
            baudrate: this.options.baudrate,
            connections: Object.keys(this.connections),
            ready: this.ready,
            controller: {
                type: this.type,
                state: this.state
            },
            workflowState: this.workflow.state,
            feeder: this.feeder.toJSON(),
            sender: this.sender.toJSON()
        };
    }
    open(callback = noop) {
        const { port, baudrate } = this.options;

        // Assertion check
        if (this.isOpen()) {
            log.error(`[Grbl] Cannot open serial port "${port}"`);
            return;
        }

        this.serialport = new SerialPort(this.options.port, {
            autoOpen: false,
            baudRate: this.options.baudrate,
            parser: SerialPort.parsers.readline('\n')
        });
        this.serialport.on('data', this.serialportListener.data);
        this.serialport.on('disconnect', this.serialportListener.disconnect);
        this.serialport.on('error', this.serialportListener.error);
        this.serialport.open((err) => {
            if (err) {
                log.error(`[Grbl] Error opening serial port "${port}":`, err);
                this.emitAll('serialport:error', { err: err, port: port });
                callback(err); // notify error
                return;
            }

            this.emitAll('serialport:open', {
                port: port,
                baudrate: baudrate,
                controllerType: this.type,
                inuse: true
            });

            callback(); // register controller

            log.debug(`[Grbl] Connected to serial port "${port}"`);

            this.workflow.stop();

            // Clear action values
            this.clearActionValues();

            if (this.sender.state.gcode) {
                // Unload G-code
                this.command(null, 'unload');
            }
        });
    }
    close() {
        const { port } = this.options;

        // Assertion check
        if (!this.serialport) {
            log.error(`[Grbl] Serial port "${port}" is not available`);
            return;
        }

        // Stop status query
        this.ready = false;

        this.emitAll('serialport:close', {
            port: port,
            inuse: false
        });
        store.unset('controllers["' + port + '"]');

        if (this.isOpen()) {
            this.serialport.removeListener('data', this.serialportListener.data);
            this.serialport.removeListener('disconnect', this.serialportListener.disconnect);
            this.serialport.removeListener('error', this.serialportListener.error);
            this.serialport.close((err) => {
                if (err) {
                    log.error(`[Grbl] Error closing serial port "${port}":`, err);
                }
            });
        }

        this.destroy();
    }
    isOpen() {
        return this.serialport && this.serialport.isOpen();
    }
    isClose() {
        return !(this.isOpen());
    }
    addConnection(socket) {
        if (!socket) {
            log.error('[Grbl] The socket parameter is not specified');
            return;
        }

        log.debug(`[Grbl] Add socket connection: id=${socket.id}`);
        this.connections[socket.id] = socket;

        if (!_.isEmpty(this.state)) {
            // Send controller state to a newly connected client
            socket.emit('Grbl:state', this.state);
        }

        if (this.sender) {
            // Send sender status to a newly connected client
            socket.emit('sender:status', this.sender.toJSON());
        }
    }
    removeConnection(socket) {
        if (!socket) {
            log.error('[Grbl] The socket parameter is not specified');
            return;
        }

        log.debug(`[Grbl] Remove socket connection: id=${socket.id}`);
        this.connections[socket.id] = undefined;
        delete this.connections[socket.id];
    }
    emitAll(eventName, ...args) {
        Object.keys(this.connections).forEach(id => {
            const socket = this.connections[id];
            socket.emit.apply(socket, [eventName].concat(args));
        });
    }
    command(socket, cmd, ...args) {
        const handler = {
            'gcode:load': () => {
                let [name, gcode, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                // TODO: This will move to sender in a future release
                if (Object.keys(context).length > 0) {
                    // Example
                    // "G0 X[posx - 8] Y[ymax]" -> "G0 X2 Y50"
                    gcode = this.translateWithContext(gcode, context);
                }

                const ok = this.sender.load(name, gcode, context);
                if (!ok) {
                    callback(new Error(`Invalid G-code: name=${name}`));
                    return;
                }

                this.event.trigger('gcode:load');

                log.debug(`[Grbl] Load G-code: name="${this.sender.state.name}", size=${this.sender.state.gcode.length}, total=${this.sender.state.total}`);

                this.workflow.stop();

                callback(null, { name, gcode, context });
            },
            'gcode:unload': () => {
                this.workflow.stop();

                // Sender
                this.sender.unload();

                this.event.trigger('gcode:unload');
            },
            'start': () => {
                log.warn(`[Grbl] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:start');
            },
            'gcode:start': () => {
                this.event.trigger('gcode:start');

                this.workflow.start();

                // Feeder
                this.feeder.clear();

                // Sender
                this.sender.next();
            },
            'stop': () => {
                log.warn(`[Grbl] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:stop');
            },
            'gcode:stop': () => {
                this.event.trigger('gcode:stop');

                this.workflow.stop();

                const activeState = _.get(this.state, 'status.activeState', '');
                const delay = 500; // 500ms
                if (activeState === GRBL_ACTIVE_STATE_RUN) {
                    this.write(socket, '!'); // hold
                }

                setTimeout(() => {
                    this.write(socket, '\x18'); // ctrl-x
                }, delay);
            },
            'pause': () => {
                log.warn(`[Grbl] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:pause');
            },
            'gcode:pause': () => {
                this.event.trigger('gcode:pause');

                this.workflow.pause();

                this.write(socket, '!');
            },
            'resume': () => {
                log.warn(`[Grbl] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:resume');
            },
            'gcode:resume': () => {
                this.event.trigger('gcode:resume');

                this.write(socket, '~');

                this.workflow.resume();
            },
            'feedhold': () => {
                this.event.trigger('feedhold');

                this.workflow.pause();

                this.write(socket, '!');
            },
            'cyclestart': () => {
                this.event.trigger('cyclestart');

                this.write(socket, '~');

                this.workflow.resume();
            },
            'statusreport': () => {
                this.write(socket, '?');
            },
            'homing': () => {
                this.event.trigger('homing');

                this.writeln(socket, '$H');
            },
            'sleep': () => {
                this.event.trigger('sleep');

                this.writeln(socket, '$SLP');
            },
            'unlock': () => {
                this.writeln(socket, '$X');
            },
            'reset': () => {
                this.workflow.stop();

                // Feeder
                this.feeder.clear();

                this.write(socket, '\x18'); // ^x
            },
            'feedOverride': () => {
                const [value] = args;

                if (value === 0) {
                    this.write(socket, '\x90');
                } else if (value === 10) {
                    this.write(socket, '\x91');
                } else if (value === -10) {
                    this.write(socket, '\x92');
                } else if (value === 1) {
                    this.write(socket, '\x93');
                } else if (value === -1) {
                    this.write(socket, '\x94');
                }
            },
            'spindleOverride': () => {
                const [value] = args;

                if (value === 0) {
                    this.write(socket, '\x99');
                } else if (value === 10) {
                    this.write(socket, '\x9a');
                } else if (value === -10) {
                    this.write(socket, '\x9b');
                } else if (value === 1) {
                    this.write(socket, '\x9c');
                } else if (value === -1) {
                    this.write(socket, '\x9d');
                }
            },
            'rapidOverride': () => {
                const [value] = args;

                if (value === 0 || value === 100) {
                    this.write(socket, '\x95');
                } else if (value === 50) {
                    this.write(socket, '\x96');
                } else if (value === 25) {
                    this.write(socket, '\x97');
                }
            },
            'lasertest:on': () => {
                const [power = 0, duration = 0] = args;
                const commands = [
                    // https://github.com/gnea/grbl/wiki/Grbl-v1.1-Laser-Mode
                    // The laser will only turn on when Grbl is in a G1, G2, or G3 motion mode.
                    'G1F1',
                    'M3S' + Math.abs(power)
                ];
                if (duration > 0) {
                    commands.push('G4P' + (duration / 1000));
                    commands.push('M5S0');
                }
                this.command(socket, 'gcode', commands);
            },
            'lasertest:off': () => {
                const commands = [
                    'M5S0'
                ];
                this.command(socket, 'gcode', commands);
            },
            'gcode': () => {
                const [commands, context] = args;
                const data = ensureArray(commands)
                    .join('\n')
                    .split('\n')
                    .filter(line => {
                        if (typeof line !== 'string') {
                            return false;
                        }

                        return line.trim().length > 0;
                    });

                this.feeder.feed(data, context);

                if (!this.feeder.isPending()) {
                    this.feeder.next();
                }
            },
            'macro:run': () => {
                let [id, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`[Grbl] Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('macro:run');

                this.command(socket, 'gcode', macro.content, context);
                callback(null);
            },
            'macro:load': () => {
                let [id, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`[Grbl] Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('macro:load');

                this.command(socket, 'gcode:load', macro.name, macro.content, context, callback);
            },
            'watchdir:load': () => {
                const [file, callback = noop] = args;
                const context = {}; // empty context

                monitor.readFile(file, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    this.command(socket, 'gcode:load', file, data, context, callback);
                });
            }
        }[cmd];

        if (!handler) {
            log.error(`[Grbl] Unknown command: ${cmd}`);
            return;
        }

        handler();
    }
    write(socket, data) {
        // Assertion check
        if (this.isClose()) {
            log.error(`[Grbl] Serial port "${this.options.port}" is not accessible`);
            return;
        }

        const cmd = data.trim();
        this.actionMask.replyStatusReport = (cmd === '?') || this.actionMask.replyStatusReport;
        this.actionMask.replyParserState = (cmd === '$G') || this.actionMask.replyParserState;

        this.emitAll('serialport:write', data);
        this.serialport.write(data);
        dbg(`[Grbl] > ${data}`);
    }
    writeln(socket, data) {
        if (_.includes(GRBL_REALTIME_COMMANDS, data)) {
            this.write(socket, data);
        } else {
            this.write(socket, data + '\n');
        }
    }
}

export default GrblController;
