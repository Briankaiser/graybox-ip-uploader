const util = require('util')
const bleno = require('bleno')
const BlenoPrimaryService = bleno.PrimaryService

const DeviceIdCharacteristic = require('./device-id-characteristic')
const LocalIpsCharacteristic = require('./local-ips-characteristic')
const ExternalIpCharacteristic = require('./external-ip-characteristic')
const DateTimeCharacteristic = require('./date-time-characteristic')
const PendingUploadCountCharacteristic = require('./pending-upload-count-characteristic')

function DeviceService (initialStatusObject, stateChangedEmitter) {
  DeviceService.super_.call(this, {
    uuid: '121212',
    characteristics: [
      new DeviceIdCharacteristic(initialStatusObject),
      new LocalIpsCharacteristic(initialStatusObject, stateChangedEmitter),
      new ExternalIpCharacteristic(initialStatusObject, stateChangedEmitter),
      new DateTimeCharacteristic(),
      new PendingUploadCountCharacteristic(initialStatusObject, stateChangedEmitter)
    ]
  })
}

util.inherits(DeviceService, BlenoPrimaryService)

module.exports = DeviceService
