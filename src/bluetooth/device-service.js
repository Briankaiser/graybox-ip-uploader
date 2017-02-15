const util = require('util')
const bleno = require('bleno')
const BlenoPrimaryService = bleno.PrimaryService

const DeviceIdCharacteristic = require('./device-id-characteristic')

function DeviceService (initialStatusObject, stateChangedEmitter) {
  DeviceService.super_.call(this, {
    uuid: '121212',
    characteristics: [
      new DeviceIdCharacteristic(initialStatusObject)
    ]
  })
}

util.inherits(DeviceService, BlenoPrimaryService)

module.exports = DeviceService
