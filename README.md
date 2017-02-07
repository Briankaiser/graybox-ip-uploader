# graybox-ip-uploader

Work in Progress

A file named local-config.yaml must be present in the ./config folder. It takes the format of the file local-config.default.yaml. Required fields are:
* deviceId
* iotHostname (for AWS IoT connectivity)

For ffmpeg to work the environment variable FFMPEG_PATH must point directly to executable or the ffmpegOverridePath property in local-config.yaml must be set to the executable path.

 All Amazon IoT certs must be placed in ./certs. The following files are required:
 * thing.cert.pem
 * thing.private.key
 * root-ca.crt
