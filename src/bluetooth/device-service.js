const util = require('util')
const bleno = require('bleno')
const BlenoPrimaryService = bleno.PrimaryService

const DeviceIdCharacteristic = require('./device-id-characteristic')

function DeviceService (initialLocalConfig, initialDeviceState, stateChangedEmitter) {
  DeviceService.super_.call(this, {
    uuid: '121212',
    characteristics: [
      new DeviceIdCharacteristic(initialLocalConfig)
    ]
  })
}

util.inherits(DeviceService, BlenoPrimaryService)

module.exports = DeviceService
