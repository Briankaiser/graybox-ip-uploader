var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var DeviceIdCharacteristic = function (initialLocalConfig) {
  DeviceIdCharacteristic.super_.call(this, {
    uuid: '2A19',
    properties: ['read'],
    // descriptors: [
    //   new Descriptor({
    //     uuid: '2901',
    //     value: 'Device Id assigned to this unit'
    //   })
    // ]
  })
  this.localConfig = initialLocalConfig
}

util.inherits(DeviceIdCharacteristic, Characteristic)

DeviceIdCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (offset) {
    callback(this.RESULT_ATTR_NOT_LONG, null)
  } else {
    callback(this.RESULT_SUCCESS, new Buffer(this.localConfig.deviceId))
  }
}

module.exports = DeviceIdCharacteristic
