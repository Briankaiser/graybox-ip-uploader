var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var PendingUploadCountCharacteristic = function (initialStatusObject, stateChangedEmitter) {
  PendingUploadCountCharacteristic.super_.call(this, {
    uuid: '2A59',
    properties: ['read'], // this could also be a notify if we wanted
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Gets count of videos pending upload'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
  stateChangedEmitter.on('statusChanged', (newStatus) => { this.status = newStatus })
}

util.inherits(PendingUploadCountCharacteristic, Characteristic)

PendingUploadCountCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    const tmpValue = this.status && this.status.filesPendingUpload ? this.status.filesPendingUpload.toString() : ''
    this._value = new Buffer(tmpValue)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

module.exports = PendingUploadCountCharacteristic
