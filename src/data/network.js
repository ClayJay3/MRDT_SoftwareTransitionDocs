// Single source of truth for the network: every fact here was pulled from the
// live Cisco switch backups (NetworkSwitchBackups/2026-0415) and the RoveComm
// manifest. The interactive topology AND the reference tables both read from
// this file, so there's exactly one place to update when the network changes.

export const VLANS = {
  2: {name: 'CoreSystems', subnet: '192.168.2.0/24', gateway: '192.168.2.1', color: '#e06c75', role: 'Power & control boards'},
  3: {name: 'AutonomyAndSensors', subnet: '192.168.3.0/24', gateway: '192.168.3.1', color: '#61afef', role: 'Compute & science'},
  4: {name: 'Cameras', subnet: '192.168.4.0/24', gateway: '192.168.4.1', color: '#98c379', role: 'Camera streams'},
  100: {name: 'BaseStation', subnet: '192.168.100.0/24', gateway: '192.168.100.1', color: '#e5c07b', role: 'Operator-side hosts'},
};

// RoveComm boards (from manifest.json). vlan is inferred from the IP's third octet.
export const BOARDS = [
  {name: 'Core', ip: '192.168.2.110', vlan: 2, role: 'Drive motors, gimbals, LEDs, watchdog', cmds: 14, tlm: 5, err: 1},
  {name: 'PMS', ip: '192.168.2.102', vlan: 2, role: 'Power Management System', cmds: 6, tlm: 6, err: 4},
  {name: 'Nav', ip: '192.168.2.104', vlan: 2, role: 'GPS + heading (Differential GPS board)', cmds: 0, tlm: 3, err: 1},
  {name: 'Arm', ip: '192.168.2.107', vlan: 2, role: 'Robotic arm', cmds: 19, tlm: 3, err: 1},
  {name: 'Auger', ip: '192.168.2.108', vlan: 2, role: 'Science drill / sample collection', cmds: 11, tlm: 5, err: 2},
  {name: 'Autonomy', ip: '192.168.3.100', vlan: 3, role: 'The Jetson, autonomous traversal & detection', cmds: 12, tlm: 4, err: 0, highlight: true},
  {name: 'IRSpectrometer', ip: '192.168.3.104', vlan: 3, role: 'Science IR spectrometer', cmds: 0, tlm: 0, err: 0},
  {name: 'Raman', ip: '192.168.3.105', vlan: 3, role: 'Science Raman spectrometer', cmds: 9, tlm: 6, err: 1},
  {name: 'Camera1', ip: '192.168.4.100', vlan: 4, role: 'Camera node 1', cmds: 6, tlm: 4, err: 0},
  {name: 'Camera2', ip: '192.168.4.101', vlan: 4, role: 'Camera node 2', cmds: 6, tlm: 4, err: 0},
  {name: 'CameraServer', ip: '192.168.4.102', vlan: 4, role: 'Aggregates/streams cameras', cmds: 9, tlm: 3, err: 1},
  {name: 'SignalStack', ip: '192.168.100.101', vlan: 100, role: 'Base-side signal/antenna control', cmds: 4, tlm: 1, err: 1},
  {name: 'BaseStationNav', ip: '192.168.100.112', vlan: 100, role: 'Base-side nav reference', cmds: 0, tlm: 0, err: 0},
];

// The three wireless bands. Each is its own /29. The rocket radios are
// transparent L2 bridges between the two switch L3 interfaces.
export const RADIO_LINKS = [
  {
    band: '900 MHz', subnet: '10.0.0.0/29', active: true,
    roverSwIf: 'Gi1/1 → 10.0.0.1', baseSwIf: 'Gi1/0/12 → 10.0.0.2',
    roverRocket: '10.0.0.3', baseRocket: '10.0.0.4',
    note: 'Long range, low bandwidth. The "we can always reach the rover" lifeline.',
  },
  {
    band: '2.4 GHz', subnet: '10.0.0.8/29', active: true,
    roverSwIf: 'Gi1/2 → 10.0.0.9', baseSwIf: 'Gi1/0/13 → 10.0.0.10',
    roverRocket: '10.0.0.11', baseRocket: '10.0.0.12',
    note: 'Mid-range, mid-bandwidth workhorse.',
  },
  {
    band: '5.8 GHz', subnet: '10.0.0.16/29', active: false,
    roverSwIf: 'Gi1/3 → 10.0.0.17 (SHUTDOWN)', baseSwIf: 'Gi1/0/14 → 10.0.0.18',
    roverRocket: '10.0.0.19', baseRocket: '10.0.0.20',
    note: 'High bandwidth, short range. Currently administratively SHUT DOWN on the rover switch (Gi1/3).',
  },
];

export const SWITCHES = {
  rover: {
    hostname: 'MRDT-CS-Rover', model: 'Cisco IE3300/IE3200 (network-advantage license)',
    ios: '17.9', loopback: '192.168.254.1/32', vtp: 'MRDT-ROVER',
    eigrpAS: 90, isRP: true,
  },
  base: {
    hostname: 'MRDT-CS-BaseStation', model: 'Cisco WS-C3560CX-12PD-S',
    ios: '15.2', loopback: '192.168.254.2/32', vtp: 'MRDT-BASESTATION',
    eigrpAS: 90, eigrpStub: true,
  },
};

// Multicast camera streams (UDP 50000).
export const MULTICAST_CAMERAS = [
  ['DriveCamLeft', '239.0.0.1'], ['DriveCamRight', '239.0.0.2'],
  ['GimbalCamLeft', '239.0.0.3'], ['GimbalCamRight', '239.0.0.4'],
  ['BackCam', '239.0.0.5'], ['AuxCam1', '239.0.0.6'], ['AuxCam2', '239.0.0.7'],
  ['AuxCam3', '239.0.0.8'], ['AuxCam4', '239.0.0.9'], ['Microscope', '239.0.0.10'],
];

export const ROVECOMM = {
  version: 3,
  udpPort: 11000,
  tcpPort: 12000,
  simUdpPort: 11001,
  simTcpPort: 12001,
  macPrefix: 'DE:AD',
  headerBytes: 6,
  multicastPort: 50000,
};
