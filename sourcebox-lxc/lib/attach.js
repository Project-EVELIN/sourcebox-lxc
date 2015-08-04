'use strict';

var events = require('events');
var net = require('net');
var util = require('util');

var binding = require('bindings')('lxc.node');
var common = require('./common');


function maybeClose(attachedProcess) {
  if (++attachedProcess._closesGot === attachedProcess._closesNeeded) {
    attachedProcess.emit('close', attachedProcess.exitCode,
                         attachedProcess.signalCode);
  }
}

function flushStdio(attachedProcess) {
  attachedProcess.stdio.forEach(function (stream) {
    if (!stream || !stream.readable || stream._consuming ||
        stream._readableState.flowing) {
      return;
    }

    stream.resume();
  });
}

function exitCallback(attachedProcess, exitCode, signalCode) {
  if (signalCode) {
    attachedProcess.signalCode = signalCode;
  } else {
    attachedProcess.exitCode = exitCode;
  }

  attachedProcess.stdin.destroy();

  if (exitCode < 0) {
    var err = common.errnoException(-exitCode, 'spawn',  attachedProcess.spawnfile);
    attachedProcess.emit('error', err);
  } else {
    attachedProcess.emit('exit', attachedProcess.exitCode, attachedProcess.signalCode);
  }

  process.nextTick(flushStdio.bind(null, attachedProcess));

  maybeClose(attachedProcess);
}

binding.setExitCallback(exitCallback);

/**
 * @class
 * @private
 */
function TTYStream(options) {
  var tty = process.binding('tty_wrap');
  var guessHandleType = tty.guessHandleType;

  tty.guessHandleType = function () {
    return 'PIPE';
  };

  TTYStream.super_.call(this, options);
  tty.guessHandleType = guessHandleType;

  this.on('error', function (err) {
    if (err.code === 'EIO') {
      // child exited
      return;
    }

    if (this.listeners('error').length <= 1) {
      throw err;
    }
  });
}

util.inherits(TTYStream, net.Socket);

TTYStream.prototype.resize = function (cols, rows) {
  binding.resize(this._handle.fd, cols, rows);
};

/**
 * Not intended to be used directly.
 *
 * @class
 * @protected
 */
function AttachedProcess(command, fds, term, container) {
  AttachedProcess.super_.call(this);

  this._closesGot = 0;
  this._closesNeeded = fds.length;
  this._ref = true;

  this.exitCode = null;
  this.signalCode = null;

  // node child API compatibility
  this.spawnfile = command;

  // container this process belongs to
  this.container = container;

  // Process ID of attached process. May not be available immediately since
  // attachment is asynchronous.
  this.pid = null;

  this.stdio = [];

  fds.forEach(function (fd, i) {
    var stream;

    if (i < 3 && term) {
      if (i === 0) {
        stream = new TTYStream({
          fd: fd,
          readable: true,
          writable: true
        });
      } else {
        stream = this.stdio[0];
      }
    } else {
      stream = new net.Socket({
        fd: fd,
        readable: i > 0,
        writable: i === 0 || i > 2
      });
    }

    if (i > 0) {
      stream.on('close', maybeClose.bind(null, this));
    }

    this.stdio[i] = stream;
  }, this);

  this.stdin = this.stdio[0];
  this.stdout = this.stdio[1];
  this.stderr = this.stdio[2];
}

util.inherits(AttachedProcess, events.EventEmitter);

AttachedProcess.prototype.ref = function () {
  this._ref = true;

  if (this.pid !== null) {
    binding.ref(this.pid);
  }
};

AttachedProcess.prototype.unref = function () {
  this._ref = false;

  if (this.pid !== null) {
    binding.unref(this.pid);
  }
};

/**
 * Send a signal to the child process. If no argument is given, the process
 * will be sent `'SIGTERM'`. See `signal(7)` for a list of available signals.
 *
 * Note that most shells will ignore or internally handle signals like
 * `SIGTERM` and `SIGQUIT`.
 *
 * @param {String} [signal=SIGTERM] Signal to send
 */
AttachedProcess.prototype.kill = function (signal) {
  if (this.pid === null) {
    throw new Error('Process not attached');
  }

  try {
    return process.kill(this.pid, signal);
  } catch (err) {
    if (err.code === undefined || err.code === 'EINVAL' ||
        err.code === 'ENOSYS') {
      // unknown or unsupported signal
      throw err;
    }

    if (err.code !== 'ESRCH') {
      this.emit('error', err);
    }
  }

  return false;
};

module.exports = AttachedProcess;