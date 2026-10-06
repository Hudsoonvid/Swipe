// Local PeerJS signaling server for tests; prints its port on stdout.
import express from 'express';
import { ExpressPeerServer } from 'peer';

const app = express();
const server = app.listen(0, '127.0.0.1', () => console.log(server.address().port));
app.use('/', ExpressPeerServer(server, { path: '/' }));
