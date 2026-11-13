// Hosted mode: this page is a frame inside a party room that has already started the round
// (party-view.js made the frame and left `partyHost` on it). There is no room of the game's own
// to make or join and no waiting room: the host has the seats, relays what its room says and
// takes this page's inputs. HostedParty is the little of the kit's PartyClient that a round
// uses, answered by the host instead of a socket.

/** The host this page was mounted by, or null when the page was opened on its own. */
export function findHost(params, win = window) {
  if (params.get("party") !== "1") return null;
  try {
    return win.frameElement?.partyHost ?? null;
  } catch {
    return null; // framed by another origin: not a host
  }
}

export class HostedParty {
  /** @param {object} host  see party-view.js: {room, you, snapshot, inset, now, send, on, ready, dispose} */
  constructor(host) {
    this.host = host;
    this.you = host.you;
    this.room = host.room;
    this.status = "open";
  }

  /** "events" and "snapshot" come from the host. Nothing else happens in a hosted round. */
  on(type, handler) {
    return type === "events" || type === "snapshot" ? this.host.on(type, handler) : () => {};
  }

  /** The room's clock, as the host's own connection keeps it. */
  now() {
    return this.host.now();
  }

  sendInput(data) {
    this.host.send(data);
  }

  /** There is no session of this page's own to pick up. */
  resume() {
    return false;
  }
}
