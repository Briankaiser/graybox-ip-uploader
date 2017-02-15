const bunyan = require('bunyan')
const path = require('path')
const os = require('os')
const deferred = require('deferred')
const _ = require('lodash')

let bleno
try {
  bleno = require('bleno')
} catch (e) {
  console.log('failed to load bleno for bluetooth', e)
  bleno = null
}

const promisify = deferred.promisify


;(function () {
  let localConfig = {}
  let deviceState = {}
  let logger


  function initBluetooth () {
    if (!bleno) {
      logger.warn('bleno not loaded')
      return
    }

    bleno.on('stateChange', function (state) {
      console.log('on -> stateChange: ' + state)

      if (state === 'poweredOn') {
        bleno.startAdvertising('TEST', ['180F'])
      } else {
        bleno.stopAdvertising()
      }
    })
    bleno.on('advertisingStart', function (error) {
      console.log('on -> advertisingStart: ' + (error ? 'error ' + error : 'success'))
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
    initBluetooth()
  }

  function ProcessUpdatedDeviceState (newState) {
    deviceState = newState
  }

  process.on('message', function (msg) {
    if (!msg) return

    if (msg.type === 'Init') {
      init(msg.payload)
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload)
    }
  })


  setInterval(function () {
    // report status

  }, 10000)
})()
