const childProcessDebug = require('child-process-debug')
const bunyan = require('bunyan')
const path = require('path')
const _ = require('lodash')
const localConfigReader = require('./local-config-reader')

;(function () {
  let childProcesses = []
  let localConfig
  let logger
  let restartAwkTimeoutInterval, pendingRestartProcess

  process.on('exit', function () {
    if (childProcesses) {
      _.each(childProcesses, function (cp) {
        if (cp) cp.kill()
      })
    }
  })

  function FindChildProcess (processes, toFindString) {
    return _.find(processes, function (p) {
      return _.some(p.spawnargs, function (sa) {
        return sa.indexOf(toFindString) > -1
      })
    })
  }
  function ProcessStatusUpdate (msg) {
    if (msg.type !== 'StatusUpdate') return

    const statusProcess = FindChildProcess(childProcesses, 'status')
    if (!statusProcess || !statusProcess.connected) return

    statusProcess.send({
      type: 'StatusUpdate',
      payload: msg.payload
    })
  }
  function RequestDeviceStateChange (payload) {
    // take the status message and push to IoT
    const iotProcess = FindChildProcess(childProcesses, 'iot')
    if (!iotProcess) return

    iotProcess.send({
      type: 'RequestDeviceStateChange',
      payload: payload
    })
  }

  function onEncoderMessage (msg) {
    if (msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg)
      return
    } else if (msg.type === 'RequestDeviceStateChange') {
      RequestDeviceStateChange(msg.payload)
    }
  }
  function onUploaderMessage (msg) {
    if (msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg)
      return
    }
  }
  function onStatusMessage (msg) {
    if (msg.type !== 'CompiledStatus') return

    // take the status message and push to IoT
    const iotProcess = FindChildProcess(childProcesses, 'iot')
    if (!iotProcess) return

    iotProcess.send({
      type: 'CompiledStatus',
      payload: msg.payload
    })

    const bluetoothProcess = FindChildProcess(childProcesses, 'bluetooth')
    if (!bluetoothProcess) return

    bluetoothProcess.send({
      type: 'CompiledStatus',
      payload: msg.payload
    })
  }
  function onIotShadowMessage (msg) {
    if (msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg)
      return
    }

    // if we are waiting to restart a process and we get a successful 'awk'
    if (pendingRestartProcess && msg.type === 'DeviceUpdateAwknowledged') {
      triggerProcessRestart(childProcesses, pendingRestartProcess)
      return
    }

    // if new device state - broadcast it to everyone
    if (msg.type === 'DeviceStateChanged') {
      // if a process restart is requested and we aren't already doing one
      if (!_.isEmpty(msg.payload.processToRestart) && !pendingRestartProcess) {
        startRestartSequence(msg.payload.processToRestart)
        msg.payload.processToRestart = null // clear this out before other processes see it
      }

      _.each(childProcesses, function (cp) {
        if (!cp.connected) return
        cp.send({
          type: 'DeviceStateChanged',
          payload: msg.payload
        })
      })
    }
  }
  function onBluetoothMessage (msg) {
    if (msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg)
    } else if (msg.type === 'RequestDeviceStateChange') {
      RequestDeviceStateChange(msg.payload)
    }
  }
  function onNetworkMessage (msg) {
    if (msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg)
      return
    }
  }
  function startRestartSequence (processToRestart) {
    const iotProcess = FindChildProcess(childProcesses, 'iot')
    if (!iotProcess) {
      logger.err('critical error. iot process not running. cant restart. restarting everything')
      process.exit(0)
      return
    }
    logger.info('starting restart sequence for: ' + processToRestart)
    // temp store value
    pendingRestartProcess = processToRestart
    // start a timeout handler
    restartAwkTimeoutInterval = setTimeout(resetRestartSequence, 30000)

    // awk (by removing) the restart request
    iotProcess.send({
      type: 'RequestDeviceStateChange',
      payload: {
        processToRestart: null
      }
    })
    // then we need to wait for it to be awknowledged by the server
  }
  function triggerProcessRestart (processes, processToRestart) {
    // clear timeout
    resetRestartSequence()
    logger.info('triggering restart for: ' + processToRestart)
    // then perform the necessary restart(s)
    if (processToRestart === 'main') {
      process.exit(0)
    } else {
      const p = FindChildProcess(processes, processToRestart)
      if (p) {
        p.kill()
      }
    }
  }

  function resetRestartSequence () {
    pendingRestartProcess = null
    clearTimeout(restartAwkTimeoutInterval)
    restartAwkTimeoutInterval = null
  }

  function sendInitToProcess (cp, config) {
    cp.send({
      type: 'Init',
      payload: config
    })
  }

  function mainInitWithConfig (config) {
    localConfig = config
    logger = bunyan.createLogger({
      name: 'main-log',
      deviceId: localConfig.deviceId,
      streams: [{
        type: 'rotating-file',
        level: 'info',
        path: path.join(config.loggingPath, 'main-log.log'),
        period: '1d',   // daily rotation
        count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'debug'
      }]
    })
  }
  function spawnRestartableProcess (processPath, messageHandler) {
    let process = childProcessDebug.fork(processPath, {
      execArgv: ['--max-old-space-size=50']    // each child only gets 64Mb because sharing is caring. and Pis have low mem
    })
    process.on('message', messageHandler)
    // on failure - restart
    process.on('exit', function (exitCode, signal) {
      _.pull(childProcesses, process)
      // if we had a graceful exit then try to restart quick
      // if an exception than wait a little longer
      const restartWaitTime = exitCode === 0 ? 1000 : 10000
      // wait 10s and restart
      setTimeout(function () {
        logger.info({processPath: processPath}, 'restarting process')
        spawnRestartableProcess(processPath, messageHandler)
        // if iot is running and it has a state - it will rebroadcast
        // if iot isn't running - on its own startup it will send out device state
        const iotProcess = FindChildProcess(childProcesses, 'iot')
        if (iotProcess) {
          iotProcess.send({
            type: 'RebroadcastRequest'
          })
        }
      }, restartWaitTime)
    })
    childProcesses.push(process)
    sendInitToProcess(process, localConfig)
  }

  function mainCreateChildProcesses () {
    // create child processes
    // spawn the encoder
    spawnRestartableProcess('./encoder/index.js', onEncoderMessage)

    // start aws iot shadow
    spawnRestartableProcess('./iot-shadow/index.js', onIotShadowMessage)

    // start monitoring process
    spawnRestartableProcess('./status/index.js', onStatusMessage)

    // start uploader process
    spawnRestartableProcess('./uploader/index.js', onUploaderMessage)

    // start bluetooth process (not on Win32 for now)
    if (process.platform !== 'win32') {
      spawnRestartableProcess('./bluetooth/index.js', onBluetoothMessage)
      spawnRestartableProcess('./network/index.js', onNetworkMessage)
    }
  }

  // main process run path
  localConfigReader.load()
    .then(mainInitWithConfig)
    .then(mainCreateChildProcesses)
    .done(function () { },
      function (err) {
        if (logger) {
          logger.error(err)
        } else {
          console.log(err)
        }
      })
})()
