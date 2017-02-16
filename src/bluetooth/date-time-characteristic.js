var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var DateTimeCharacteristic = function () {
  DateTimeCharacteristic.super_.call(this, {
    uuid: '2A49',
    properties: ['read'],
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Gets the device date-time'
      })
    ]
  })
  this._value = new Buffer(0)
}

util.inherits(DateTimeCharacteristic, Characteristic)

DateTimeCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    this._value = new Buffer(new Date().toISOString())
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = DateTimeCharacteristic
