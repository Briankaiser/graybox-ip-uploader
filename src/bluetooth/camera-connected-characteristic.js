var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var CameraConnectedCharacteristic = function (initialStatusObject, stateChangedEmitter) {
  CameraConnectedCharacteristic.super_.call(this, {
    uuid: '2A69',
    properties: ['read'], // this could also be a notify if we wanted
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Can the device ping the cameras IP address'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
  stateChangedEmitter.on('statusChanged', (newStatus) => { this.status = newStatus })
}

util.inherits(CameraConnectedCharacteristic, Characteristic)

CameraConnectedCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    const tmpValue = this.status && this.status.cameraPing ? '1' : '0'
    this._value = new Buffer(tmpValue)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = CameraConnectedCharacteristic
