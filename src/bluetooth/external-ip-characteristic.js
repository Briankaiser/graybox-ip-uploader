var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var ExternalIPCharacteristic = function (initialStatusObject, stateChangedEmitter) {
  ExternalIPCharacteristic.super_.call(this, {
    uuid: '2A39',
    properties: ['read'],
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Gets the external IP of the device'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
  stateChangedEmitter.on('statusChanged', (newStatus) => { this.status = newStatus })
}

util.inherits(ExternalIPCharacteristic, Characteristic)

ExternalIPCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    this._value = new Buffer(this.status.externalIp || '<unknown>')
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = ExternalIPCharacteristic
