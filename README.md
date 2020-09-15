# grbl-stream

Stream based [Grbl](https://github.com/gnea/grbl) command parser and serializer. Transport protocol independent. At the moment only supports a subset of commands.

    npm install grbl-stream


## Usage

The protocol stream can be used with any stream based transport, e.g. using with [serialport](https://github.com/serialport/node-serialport).

```javascript
const SerialPort = require('serialport')
const { GrblStream } = require('grbl-stream')

const port = new SerialPort('/dev/tty.usbmodem', { baudRate: 115200 })
const grbl = new GrblStream()

grbl.pipe(port).pipe(grbl)
  .on('command', cmd => console.log('>', cmd))
  .on('message', msg => console.log('<', msg))

console.log('status', await grbl.status())
console.log('help', await grbl.help())
console.log('settings', await grbl.settings())

await grbl.runHomingCycle()
await grbl.killAlarmLock()
await grbl.metricCoordinates()
await grbl.incrementalPositioning()
await grbl.position({ x: -100, y: -100 })
```
