// Provider DTO boundary. Raw credentials/responses never enter the workflow.
export class KtvRoomControlGateway {
  async ensureSession() { throw Error('Gateway not implemented'); }
  async getRoomStatus() { throw Error('Gateway not implemented'); }
  async closeRoom() { throw Error('Gateway not implemented'); }
  // One provider effect: open with countdownSeconds toward targetEndAt.
  // A separate timer mutation is not an assumed provider capability.
  async openRoom() { throw Error('Gateway not implemented'); }
  async queryRoomState() { throw Error('Gateway not implemented'); }
}
export class KtvSkyRoomControlGateway extends KtvRoomControlGateway {
  get productionEnabled() { return false; }
  async ensureSession() { throw Error('KTVSky production control is not enabled'); }
  async getRoomStatus() { return this.ensureSession(); }
  async closeRoom() { return this.ensureSession(); }
  async openRoom() { return this.ensureSession(); }
  async queryRoomState() { return this.ensureSession(); }
}
