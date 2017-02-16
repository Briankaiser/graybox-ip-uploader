var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var IoTConnectedCharacteristic = function (initialStatusObject, stateChangedEmitter) {
  IoTConnectedCharacteristic.super_.call(this, {
    uuid: '2A79',
    properties: ['read'], // this could also be a notify if we wanted
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Is the device connected to AWS IoT'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
  stateChangedEmitter.on('statusChanged', (newStatus) => { this.status = newStatus })
}

util.inherits(IoTConnectedCharacteristic, Characteristic)

IoTConnectedCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    const tmpValue = this.status && this.status.iotConnected ? '1' : '0'
    this._value = new Buffer(tmpValue)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = IoTConnectedCharacteristic
