const bunyan = require('bunyan')
const path = require('path')
const events = require('events')
const _ = require('lodash')
const DeviceService = require('./device-service')

let bleno
try {
  if (process.platform !== 'win32') { // don't try to include on windows
    bleno = require('bleno')
  }
} catch (e) {
  console.log('failed to load bleno for bluetooth', e)
  bleno = null
}

;(function () {
  let localConfig = {}
  let deviceState = {}
  let mergedStatusObject = {}
  let logger
  let changeNotifier
  let deviceServiceInstance

  process.on('exit', function () {
    if (changeNotifier) {
      changeNotifier.removeAllListeners()
    }
    if (bleno) {
      bleno.stopAdvertising()
    }
  })

  function initBluetooth () {
    if (!bleno) {
      logger.warn('bleno not loaded')
      return
    }

    changeNotifier = new events.EventEmitter()
    deviceServiceInstance = new DeviceService(mergedStatusObject, changeNotifier)

    bleno.on('stateChange', function (state) {
      logger.info({state: state}, 'bluetooth state changed')

      if (state === 'poweredOn') {
        bleno.startAdvertising(localConfig.deviceId, [deviceServiceInstance.uuid])
      } else {
        bleno.stopAdvertising()
      }
    })
    bleno.on('advertisingStart', function (error) {
      // console.log('on -> advertisingStart: ' + (error ? 'error ' + error : 'success'))
      if (!error) {
        bleno.setServices([
          deviceServiceInstance
        ])
      }
    })
  }
  function init (config) {
    localConfig = config
    logger = bunyan.createLogger({
      name: 'bluetooth-log',
      deviceId: localConfig.deviceId,
      streams: [{
        type: 'rotating-file',
        level: 'info',
        path: path.join(config.loggingPath, 'bluetooth-log.log'),
        period: '1d',   // daily rotation
        count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'debug'
      }]
    })
    mergedStatusObject = _.merge(mergedStatusObject, localConfig)

    initBluetooth()
  }

  function ProcessUpdatedDeviceState (newState) {
    deviceState = newState
    mergedStatusObject = _.merge(mergedStatusObject, deviceState)
    if (changeNotifier) {
      changeNotifier.emit('statusChanged', mergedStatusObject)
    }
  }
  function ProcessCompiledStatus (newStatus) {
    mergedStatusObject = _.merge(mergedStatusObject, newStatus)
    if (changeNotifier) {
      changeNotifier.emit('statusChanged', mergedStatusObject)
    }
  }

  process.on('message', function (msg) {
    if (!msg) return

    if (msg.type === 'Init') {
      init(msg.payload)
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload)
    } else if (msg.type === 'CompiledStatus') {
      ProcessCompiledStatus(msg.payload)
    }
  })


  setInterval(function () {
    // report status

  }, 10000)
})()
