var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var DeviceIdCharacteristic = function (initialLocalConfig) {
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
  this.localConfig = initialLocalConfig
  this._value = new Buffer(0)
}

util.inherits(DeviceIdCharacteristic, Characteristic)

DeviceIdCharacteristic.prototype.onReadRequest = function (offset, callback) {
  console.log('read request', offset, callback, this.localConfig.deviceId)
  if (!offset) {
    this._value = new Buffer(this.localConfig.deviceId)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = DeviceIdCharacteristic
