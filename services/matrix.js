'use strict';

// Dependencies
const matrix = require('matrix-js-sdk');

// Fabric Types
const Key = require('@fabric/core/types/key');
const Actor = require('@fabric/core/types/actor');
const Hash256 = require('@fabric/core/types/hash256');
const Service = require('@fabric/core/types/service');
const Message = require('@fabric/core/types/message');

/**
 * Service for interacting with Matrix.
 * @augments Service
 */
class Matrix extends Service {
  /**
   * Create an instance of a Matrix client, connect to the
   * network, and relay messages received from therein.
   * @param {Object} [settings] Configuration values.
   * @param {String} [settings.seed] BIP39 seed phrase.
   * @param {String} [settings.password] Password for authentication with Matrix.
   */
  constructor (settings = {}) {
    super(settings);

    // Assign defaults
    this.settings = Object.assign({
      alias: 'FABRIC',
      autojoin: true,
      handle: '@fabric:fabric.pub',
      name: '@fabric/matrix',
      path: './stores/matrix',
      homeserver: 'https://fabric.pub',
      coordinator: '!pPjIUAOkwmgXeICrzT:fabric.pub',
      constraints: {
        sync: {
          limit: 10000
        }
      },
      token: null,
      connect: true
    }, this.settings, settings);

    // Client & Key
    this.client = matrix.createClient({
      baseUrl: this.settings.homeserver,
      accessToken: this.settings.token,
      userId: this.settings.handle
    });

    this.key = new Key(this.settings);

    // Internal State
    this._state = {
      status: 'READY',
      actors: {},
      channels: {},
      messages: {},
      users: {},
      validators: {}
    };

    return this;
  }

  get id () {
    const actor = this._ensureUser({ id: this.settings.handle });
    return actor.id;
  }

  get status () {
    return this._state.status;
  }

  set status (value = this.status) {
    switch (value) {
      case 'READY':
        this._state.status = value;
        break;
      default:
        return false;
    }

    return true;
  }

  /**
   * Getter for {@link State}.
   */
  get state () {
    return this._state;
  }

  get statehash () {
    return (new Actor(this.state)).id;
  }

  async alert (msg) {
    await this._send({
      object: {
        content: msg
      }
    });
  }

  async _getAgentDisplayName () {
    const user = await this.client.getProfileInfo(this.settings.handle);
    return user.displayname;
  }

  async _getEvent (eventID) {
    let rooms = this.client.getRooms();
    let specificEvent = null;

    // Deep search
    for (let i = rooms.length - 1; i >= 0; i--) {
      let room = rooms[i];
      let timeline = room.timeline;

      for (let j = timeline.length - 1; j >= 0; j--) {
        let event = timeline[j];
        if (event.getId() === eventID) {
          specificEvent = event;
          break;
        }
      }

      if (specificEvent) break;
    }

    if (specificEvent) {
      return specificEvent;
    } else {
      return null;
    }
  }

  async _getReactions (eventID) {
    const reactions = [];
    const rooms = this.client.getRooms();

    for (let i = rooms.length - 1; i >= 0; i--) {
      const room = rooms[i];
      const timeline = room.timeline;

      for (let j = timeline.length - 1; j >= 0; j--) {
        const event = timeline[j];
        if (event.getType() === 'm.reaction' && event.event.content['m.relates_to'] && event.event.content['m.relates_to'].event_id === eventID) {
          reactions.push({
            userId: event.getSender(),
            key: event.event.content['m.relates_to'].key,
          });
        }
      }
    }

    return reactions;
  }

  async _getRoomMembers (roomID) {
    const rooms = this.client.getJoinedRooms();
    return rooms;
  }

  async _handleException (exception) {
    console.error('[SERVICES:MATRIX]', 'Exception:', exception);
  }

  async _listPublicRooms () {
    const rooms = await this.client.publicRooms();
    return rooms;
  }

  async _queryServerForRoomUsers () {
    const room = await this.client.getRoom(this.settings.coordinator);
    if (room && room.currentState) {
      return room.currentState.members;
    } else {
      return null;
    }
  }

  async _syncPublicRooms () {
    const rooms = await this.client.publicRooms();
    return rooms;
  }

  async _react (eventID, emoji) {
    const event = await this._getEvent(eventID);
    const reactionContent = {
      'm.relates_to': {
        'rel_type': 'm.annotation',
        'event_id': eventID,
        'key': emoji
      }
    };

    const result = await this.client.sendEvent(event.event.room_id, 'm.reaction', reactionContent);

    return {
      object: {
        id: result.event_id
      }
    };
  }

  async _redact (eventID) {
    const event = await this._getEvent(eventID);
    this.client.redactEvent(event.event.room_id, eventID);
  }

  /**
   * Register an Actor on the network.
   * @param {Object} actor Actor to register.
   * @param {Object} actor.pubkey Hex-encoded pubkey.
   */
  async _registerActor (object) {
    if (!object.pubkey) throw new Error('Field "pubkey" is required.');

    // ### The Canonical Actor
    // The current method of deriving actor IDs is deterministic, with IDs
    // bound to the actor's public key.  No additional data is captured.
    const actor = new Actor({ pubkey: object.pubkey });
    const memory = Object.assign({}, object);

    if (object.password) delete memory.password;

    // First, add the actor to our local state:
    this._state.actors[actor.id] = memory;

    // Next, determine if a connection should be made:
    // TODO: reduce and simplify this entire path
    if (this.settings.connect) {
      // Assign some mapped values for Matrix:
      const username = object.pubkey;
      // NOTE: this is NOT the actor's private key
      const hashpass = Hash256.digest(Hash256.digest(this.key.private.toString()));
      const password = object.password || hashpass; // falls back to hashpass

      // BEGIN: REGISTRATION / LOGIN FLOW
      let available = false;
      let registration = null;

      try {
        this.emit('log', `Checking availability: ${username}`);
        available = await this._checkUsernameAvailable(username);
        this.emit('message', Message.fromVector(['OracleBoolean', available]));
      } catch (exception) {
        this.emit('error', `Could not check availability: ${exception}`);
      }

      if (available) {
        try {
          this.emit('log', `Trying registration: ${username}`);
          registration = await this.register(username, password);
          this.emit('log', 'Registration:', registration);
        } catch (exception) {
          this.emit('error', `Could not register with coordinator: ${exception}`);
        }
      }

      try {
        this.emit('log', `Trying login: ${username}`);
        await this.login(username, password);
      } catch (exception) {
        this.emit('error', `Could not authenticate with coordinator: ${exception}`);
      }

      try {
        this.emit('log', `Trying join room: ${this.settings.coordinator}`);
        await this.client.joinRoom(this.settings.coordinator);
      } catch (exception) {
        this.emit('error', `Could not join coordinator: ${exception}`);
      }
      // END: REGISTRATION / LOGIN FLOW

      /* this.emit('log', {
        actor: username,
        object: result.event_id,
        target: '/messages'
      }); */
    }

    this.log('message', `Actor Registered: ${actor.id} ${JSON.stringify(actor.data, null, '  ')}`);
    this.emit('actor', actor.id);

    return actor.data;
  }

  async _send (msg, channel = this.settings.coordinator) {
    const content = {
      body: (msg && msg.object) ? msg.object.content : msg.object,
      msgtype: 'm.text'
    };

    const result = await this.client.sendEvent(channel, 'm.room.message', content, '');

    return {
      matrix: result
    };
  }

  async _setAgentDisplayName (name) {
    return this.client.setDisplayName(name);
  }

  async login (username, password) {
    return this.client.login('m.login.password', { user: username, password: password });
  }

  async register (username, password) {
    if (!username) throw new Error('Must provide username.');
    if (!password) throw new Error('Must provide password.');
    this.emit('log', `Trying registration: ${username}:${password}`);

    let result = null;

    try {
      result = await this.client.registerRequest({
        username: username,
        password: password,
        // auth: { type: 'm.login.dummy' }
      });
    } catch (exception) {
      console.error('no reg:', exception);
    }

    return result;
  }

  async _checkUsernameAvailable (username) {
    const self = this;
    const promise = new Promise((resolve, reject) => {
      self.emit('log', `Checking username: ${username}`);
      self.client.isUsernameAvailable(username).catch((exception) => {
        resolve(false);
      }).then((result) => {
        resolve(true);
      });
    });
    return promise;
  }

  async _handleMatrixActivity (activity) {
    // console.log('activity:', activity);
  }

  async _handleMatrixMessage (msg) {
    const actor = this._ensureUser({ id: msg.event.sender });
    switch (msg.getType()) {
      case 'm.room.message':
        this.emit('activity', {
          actor: actor.id,
          object: {
            content: msg.event.content.body
          },
          target: `/rooms/${msg.event.room_id}`
        });
        break;
      default:
        this.emit('warning', `Unhandled Matrix message type: ${msg.getType()}`);
        break;
    }
  }

  _handleClientSync (status, prevState, res) {
    if (status.trim() === 'PREPARED') {
      this.emit('message', Message.fromVector(['MatrixClientSync', {
        created: (new Date()).toISOString(),
        status: status
      }]));
      this.emit('prepared', status);
    } else {
      this.emit('error', Message.fromVector(['GenericError', {
        message: `Unhandled sync event state: ${status}`
      }]));
      process.exit();
    }
  }

  async _handleRoomTimeline (event, room, toStartOfTimeline) {
    // console.log('timeline event:', event.event, room);
    // this.emit('debug', `Matrix Timeline Event: ${JSON.stringify(event, null, '  ')}`);
    const actor = this._ensureUser({ id: event.event.sender });
    switch (event.getType()) {
      case 'm.room.message':
        await this._syncState();
        this.emit('activity', {
          actor: actor.id,
          object: {
            id: event.event.event_id,
            content: event.event.content.body
          },
          target: `/rooms/${room.roomId}`
        });
        break;
      default:
        this.emit('warning', `Unhandled Matrix message type: ${event.getType()}`);
        break;
    }
  }

  _ensureUser (user) {
    const actor = new Actor({ id: user.id });
    this._state.actors[actor.id] = actor.data;
    this._state.users[user.id] = {
      actor: actor.id
    };
    return actor;
  }

  async _syncState () {
    const event = await this._publishState(this.state);
    return {
      // event: event.event_id
    };
  }

  async _handlePreparedEvent (status) {
    this.client.on('Room.timeline', this._handleRoomTimeline.bind(this));
    await this._syncState();
    this.emit('ready');
  }

  async _publishState (state) {
    // TODO: read room state before publishing
    /* const room = await this.client.getRoom(this.settings.coordinator);
    const current = await this.client.roomState(this.settings.coordinator);
    const search = await this.client.searchRoomEvents({
      filter: { type: 'm.room.state' }
    });
    console.log('state:', room.currentState);
    console.log('state:', current);
    console.log('search:', search); */
    // return this.client.sendEvent(this.settings.coordinator, 'm.room.state', state);
  }

  /**
   * Start the service, including the initiation of an outbound connection
   * to any peers designated in the service's configuration.
   */
  async start () {
    this.status = 'STARTING';
    this.emit('log', '[SERVICES:MATRIX] Starting...');

    const user = {
      pubkey: (this.settings.username) ? this.settings.username : this.key.pubkey,
      password: this.settings.password
    };

    this.client.once('sync', this._handleClientSync.bind(this));

    this.on('activity', this._handleMatrixActivity.bind(this));
    this.on('prepared', this._handlePreparedEvent.bind(this));

    // this.client.on('Room.timeline', this._handleRoomTimeline.bind(this));

    // TODO: re-evaluate registration flow inside this function
    // await this._registerActor(user);

    if (this.settings.connect) {
      await this.client.startClient({ initialSyncLimit: this.settings.constraints.sync.limit });
      await this.client.joinRoom(this.settings.coordinator);
    }

    this.client.on('RoomMember.membership', (event, member) => {
      if (this.settings.autojoin && member.membership === 'invite' && member.userId === this.settings.handle) {
        this.client.joinRoom(member.roomId);
      }
    });

    this.status = 'STARTED';
    this.emit('log', '[SERVICES:MATRIX] Started!');
    // this.log('[SERVICES:MATRIX]', 'Started!');

    return this;
  }

  /**
   * Stop the service.
   */
  async stop () {
    this.status = 'STOPPING';
    // this.log('[SERVICES:MATRIX]', 'Stopping...');
    this.status = 'STOPPED';
    // this.log('[SERVICES:MATRIX]', 'Stopped!');

    return this;
  }
}

module.exports = Matrix;
