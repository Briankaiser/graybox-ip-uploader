var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var DeviceIdCharacteristic = function (initialStatusObject) {
  DeviceIdCharacteristic.super_.call(this, {
    uuid: '2A19',
    properties: ['read'],
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Gets the Device Id'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
}

util.inherits(DeviceIdCharacteristic, Characteristic)

DeviceIdCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    this._value = new Buffer(this.status.deviceId)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = DeviceIdCharacteristic
