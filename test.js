const SerialPort = require('serialport')
const { GrblStream } = require('.')

const main = async function () {
  const port = new SerialPort('/dev/tty.usbmodem141101', { baudRate: 115200 })
  const grbl = new GrblStream()

  grbl.pipe(port).pipe(grbl)
    .on('version', ver => console.log('version', ver))
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
}

main().catch(console.error)
