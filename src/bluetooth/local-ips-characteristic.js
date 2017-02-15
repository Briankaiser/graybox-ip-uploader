var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var LocalIPsCharacteristic = function (initialStatusObject, stateChangedEmitter) {
  LocalIPsCharacteristic.super_.call(this, {
    uuid: '2A29',
    properties: ['read'],
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Gets the list of local IP addresses'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
  stateChangedEmitter.on('statusChanged', (newStatus) => { this.status = newStatus })
}

util.inherits(LocalIPsCharacteristic, Characteristic)

LocalIPsCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    this._value = new Buffer(this.status.internalIps || '<unknown>')
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = LocalIPsCharacteristic
