require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = mysql.createPool(
{
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 10
});

const DEFAULT_ROOM_MINUTES = 120;
const MAX_ID_ATTEMPTS = 10;
const MAX_PASSWORD_LENGTH = 10;
const MAX_ROOM_NAME_LENGTH = 10;
const MAX_EDITORS = 20;
const MIN_ROOM_MINUTES = 1;
const EXPIRY_CHECK_MS = 30000;
const MAX_ROOM_MINUTES = 10080;
const MAX_TITLE_LENGTH = 40;
const MAX_CODE_LENGTH = 100000;
const SAVE_DELAY_MS = 800;
const saveTimers = new Map();

const joinLimiter = rateLimit(
{
    windowMs: 5 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many wrong attempts. Try again in 5 minutes.' }
});

const openLimiter = rateLimit(
{
    windowMs: 5 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a few minutes.' }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function generateRoomId()
{
    return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function isValidToken(token)
{
    return typeof token === 'string' && /^[a-f0-9]{32}$/.test(token);
}

function isValidRoomId(roomId)
{
    return typeof roomId === 'string' && /^[A-F0-9]{4}$/.test(roomId);
}

function cleanText(value)
{
    if (typeof value !== 'string')
    {
        return '';
    }

    return value.trim();
}

function toTitleCase(text)
{
    return text.replace(/(^|\s)(\S)/g, function (match, space, letter)
    {
        return space + letter.toUpperCase();
    });
}

function readRoomId(value)
{
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function passwordMatches(enteredPassword, savedPassword)
{
    const enteredHash = crypto.createHash('sha256').update(enteredPassword).digest();
    const savedHash = crypto.createHash('sha256').update(savedPassword).digest();

    return crypto.timingSafeEqual(enteredHash, savedHash);
}

async function createRoom(roomName, roomPassword, adminToken)
{
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++)
    {
        const roomId = generateRoomId();
        const connection = await pool.getConnection();

        try
        {
            await connection.beginTransaction();

            await connection.query(
                'INSERT INTO rooms (room_id, room_name, room_password, expires_at) ' +
                'VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
                [roomId, roomName, roomPassword, DEFAULT_ROOM_MINUTES]
            );

            await connection.query(
                'INSERT INTO users (room_id, guest_token, guest_name, guest_number, role) ' +
                'VALUES (?, ?, ?, 0, ?)',
                [roomId, adminToken, 'Admin', 'admin']
            );

            await connection.commit();
            return roomId;
        }
        catch (error)
        {
            await connection.rollback();

            if (error.code !== 'ER_DUP_ENTRY')
            {
                throw error;
            }
        }
        finally
        {
            connection.release();
        }
    }

    throw new Error('Could not generate a unique room ID');
}

async function findActiveRoom(roomId)
{
    const [rows] = await pool.query(
        'SELECT room_id, room_password FROM rooms WHERE room_id = ? AND expires_at > NOW()',
        [roomId]
    );

    return rows[0] || null;
}

async function findGuest(roomId, guestToken)
{
    const [rows] = await pool.query(
        'SELECT guest_name, role, is_kicked FROM users WHERE room_id = ? AND guest_token = ?',
        [roomId, guestToken]
    );

    return rows[0] || null;
}

async function getOrCreateGuest(roomId, guestToken)
{
    const existingGuest = await findGuest(roomId, guestToken);

    if (existingGuest)
    {
        return existingGuest;
    }

    const connection = await pool.getConnection();

    try
    {
        await connection.beginTransaction();

        await connection.query(
            'UPDATE rooms SET next_guest_number = LAST_INSERT_ID(next_guest_number) + 1 WHERE room_id = ?',
            [roomId]
        );

        const [rows] = await connection.query('SELECT LAST_INSERT_ID() AS guest_number');
        const guestNumber = rows[0].guest_number;
        const guestName = 'Guest' + guestNumber;

        await connection.query(
            'INSERT INTO users (room_id, guest_token, guest_name, guest_number, role) ' +
            'VALUES (?, ?, ?, ?, ?)',
            [roomId, guestToken, guestName, guestNumber, 'member']
        );

        await connection.commit();
        return { guest_name: guestName, role: 'member', is_kicked: 0 };
    }
    catch (error)
    {
        await connection.rollback();

        if (error.code === 'ER_DUP_ENTRY')
        {
            return await findGuest(roomId, guestToken);
        }

        throw error;
    }
    finally
    {
        connection.release();
    }
}

app.get('/api/health', async (req, res) =>
{
    try
    {
        const [rows] = await pool.query('SELECT COUNT(*) AS total FROM rooms');
        res.json({ status: 'ok', rooms: rows[0].total });
    }
    catch (error)
    {
        console.error('Database error:', error.message);
        res.status(500).json({ status: 'error' });
    }
});

app.post('/api/rooms/create', async (req, res) =>
{
    const body = req.body || {};
    const roomName = toTitleCase(cleanText(body.roomName));
    const roomPassword = typeof body.roomPassword === 'string' ? body.roomPassword : '';
    const adminToken = body.adminToken;

    if (roomName.length < 1 || roomName.length > MAX_ROOM_NAME_LENGTH)
    {
        return res.status(400).json({ error: 'Room name must be 1 to 10 characters.' });
    }

    if (roomPassword.length > MAX_PASSWORD_LENGTH)
    {
        return res.status(400).json({ error: 'Password can be at most 10 characters.' });
    }

    if (!isValidToken(adminToken))
    {
        return res.status(400).json({ error: 'Invalid browser token.' });
    }

    try
    {
        const roomId = await createRoom(roomName, roomPassword, adminToken);
        res.json({ roomId: roomId });
    }
    catch (error)
    {
        console.error('Create room error:', error.message);
        res.status(500).json({ error: 'Could not create the room. Please try again.' });
    }
});

app.post('/api/rooms/join', joinLimiter, async (req, res) =>
{
    const body = req.body || {};
    const roomId = readRoomId(body.roomId);
    const roomPassword = typeof body.roomPassword === 'string' ? body.roomPassword : '';
    const guestToken = body.guestToken;

    if (!isValidToken(guestToken))
    {
        return res.status(400).json({ error: 'Invalid browser token.' });
    }

    if (!isValidRoomId(roomId))
    {
        return res.status(404).json({ error: 'Room does not exist or was closed.' });
    }

    if (roomPassword.length > MAX_PASSWORD_LENGTH)
    {
        return res.status(401).json({ error: 'Wrong password.' });
    }

    try
    {
        const room = await findActiveRoom(roomId);

        if (!room)
        {
            return res.status(404).json({ error: 'Room does not exist or was closed.' });
        }

        if (!passwordMatches(roomPassword, room.room_password))
        {
            return res.status(401).json({ error: 'Wrong password.' });
        }

        const guest = await getOrCreateGuest(roomId, guestToken);

        if (!guest || guest.is_kicked)
        {
            return res.status(403).json({ error: 'You were removed from this room.' });
        }

        res.json({ roomId: roomId, role: guest.role, guestName: guest.guest_name });
    }
    catch (error)
    {
        console.error('Join room error:', error.message);
        res.status(500).json({ error: 'Could not join the room. Please try again.' });
    }
});

app.post('/api/rooms/open', openLimiter, async (req, res) =>
{
    const body = req.body || {};
    const roomId = readRoomId(body.roomId);
    const guestToken = body.guestToken;

    if (!isValidRoomId(roomId) || !isValidToken(guestToken))
    {
        return res.status(400).json({ error: 'Invalid room link.' });
    }

    try
    {
        const room = await findActiveRoom(roomId);

        if (!room)
        {
            return res.json({ notFound: true });
        }

        if (room.room_password !== '')
        {
            return res.json({ needsPassword: true });
        }

        const guest = await getOrCreateGuest(roomId, guestToken);

        if (!guest || guest.is_kicked)
        {
            return res.status(403).json({ error: 'You were removed from this room.' });
        }

        res.json({ joined: true });
    }
    catch (error)
    {
        console.error('Open room error:', error.message);
        res.status(500).json({ error: 'Could not open the room. Please try again.' });
    }
});

app.post('/api/rooms/access', async (req, res) =>
{
    const body = req.body || {};
    const roomId = readRoomId(body.roomId);
    const guestToken = body.guestToken;

    if (!isValidRoomId(roomId) || !isValidToken(guestToken))
    {
        return res.status(403).json({ error: 'You do not have access to this room.' });
    }

    try
    {
        const [rows] = await pool.query(
            'SELECT r.room_name, r.room_password, TIMESTAMPDIFF(SECOND, NOW(), r.expires_at) AS seconds_left, ' +
            'UNIX_TIMESTAMP(r.expires_at) AS expires_unix, ' +
            'u.guest_name, u.role, u.is_kicked ' +
            'FROM rooms r JOIN users u ON u.room_id = r.room_id ' +
            'WHERE r.room_id = ? AND u.guest_token = ? AND r.expires_at > NOW()',
            [roomId, guestToken]
        );
        const member = rows[0];

        if (!member)
        {
            const room = await findActiveRoom(roomId);

            if (!room)
            {
                return res.status(404).json({ error: 'Room does not exist or was closed.' });
            }

            return res.status(403).json({ error: 'You do not have access to this room.', notMember: true });
        }

        if (member.is_kicked)
        {
            return res.status(403).json({ error: 'You were removed from this room.' });
        }

        res.json(
        {
            roomId: roomId,
            roomName: member.room_name,
            guestName: member.guest_name,
            role: member.role,
            secondsLeft: member.seconds_left,
            expiresAt: Number(member.expires_unix) * 1000,
            serverNow: Date.now(),
            roomPassword: member.role === 'admin' ? member.room_password : undefined
        });
    }
    catch (error)
    {
        console.error('Access check error:', error.message);
        res.status(500).json({ error: 'Could not open the room. Please try again.' });
    }
});

app.post('/api/rooms/close', async (req, res) =>
{
    const body = req.body || {};
    const roomId = readRoomId(body.roomId);
    const guestToken = body.guestToken;

    if (!isValidRoomId(roomId) || !isValidToken(guestToken))
    {
        return res.status(403).json({ error: 'Only the Admin can close the room.' });
    }

    try
    {
        const guest = await findGuest(roomId, guestToken);

        if (!guest || guest.is_kicked || guest.role !== 'admin')
        {
            return res.status(403).json({ error: 'Only the Admin can close the room.' });
        }

        await pool.query('DELETE FROM rooms WHERE room_id = ?', [roomId]);
        io.to('room:' + roomId).emit('room-closed');
        presence.delete(roomId);
        res.json({ closed: true });
    }
    catch (error)
    {
        console.error('Close room error:', error.message);
        res.status(500).json({ error: 'Could not close the room. Please try again.' });
    }
});

app.post('/api/rooms/mine', async (req, res) =>
{
    const body = req.body || {};
    const guestToken = body.guestToken;

    if (!isValidToken(guestToken))
    {
        return res.status(400).json({ error: 'Invalid browser token.' });
    }

    try
    {
        const [rows] = await pool.query(
            'SELECT r.room_id, r.room_name, u.role, u.is_kicked, ' +
            'TIMESTAMPDIFF(SECOND, NOW(), r.expires_at) AS seconds_left ' +
            'FROM users u JOIN rooms r ON r.room_id = u.room_id ' +
            'WHERE u.guest_token = ? AND r.expires_at > NOW() ' +
            'ORDER BY u.joined_at DESC',
            [guestToken]
        );

        res.json({ rooms: rows });
    }
    catch (error)
    {
        console.error('My rooms error:', error.message);
        res.status(500).json({ error: 'Could not load your rooms.' });
    }
});

app.get('/:roomId', (req, res, next) =>
{
    const roomId = req.params.roomId.toUpperCase();

    if (!isValidRoomId(roomId))
    {
        return next();
    }

    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

io.use(async (socket, next) =>
{
    const auth = socket.handshake.auth || {};
    const roomId = readRoomId(auth.roomId);
    const guestToken = auth.guestToken;

    if (!isValidRoomId(roomId) || !isValidToken(guestToken))
    {
        return next(new Error('no-access'));
    }

    try
    {
        const [rows] = await pool.query(
            'SELECT u.user_id, u.guest_name, u.is_kicked ' +
            'FROM users u JOIN rooms r ON r.room_id = u.room_id ' +
            'WHERE u.room_id = ? AND u.guest_token = ? AND r.expires_at > NOW()',
            [roomId, guestToken]
        );

        const member = rows[0];

        if (!member || member.is_kicked)
        {
            return next(new Error('no-access'));
        }

        socket.data.roomId = roomId;
        socket.data.userId = member.user_id;
        socket.data.guestName = member.guest_name;
        next();
    }
    catch (error)
    {
        console.error('Socket auth error:', error.message);
        next(new Error('server-error'));
    }
});

const PRESENCE_GRACE_MS = 10000;
const presence = new Map();

async function sendPresence(roomId)
{
    const online = presence.get(roomId);

    if (!online || online.size === 0)
    {
        io.to('admin:' + roomId).emit('presence', { users: [] });
        return;
    }

    try
    {
        const [rows] = await pool.query(
            'SELECT user_id, guest_name, role FROM users WHERE room_id = ? AND user_id IN (?) ORDER BY guest_number',
            [roomId, Array.from(online.keys())]
        );

        io.to('admin:' + roomId).emit('presence',
        {
            users: rows.map((row) =>
            {
                return { userId: row.user_id, guestName: row.guest_name, role: row.role };
            })
        });
    }
    catch (error)
    {
        console.error('Presence error:', error.message);
    }
}

function addPresence(roomId, userId)
{
    let room = presence.get(roomId);

    if (!room)
    {
        room = new Map();
        presence.set(roomId, room);
    }

    let entry = room.get(userId);

    if (!entry)
    {
        entry = { count: 0, timer: null };
        room.set(userId, entry);
    }

    clearTimeout(entry.timer);
    entry.timer = null;
    entry.count++;

    sendPresence(roomId);
}

function removePresence(roomId, userId)
{
    const room = presence.get(roomId);
    const entry = room ? room.get(userId) : null;

    if (!entry)
    {
        return;
    }

    entry.count--;

    if (entry.count > 0)
    {
        return;
    }

    entry.timer = setTimeout(() =>
    {
        room.delete(userId);

        if (room.size === 0)
        {
            presence.delete(roomId);
        }

        sendPresence(roomId);
    }, PRESENCE_GRACE_MS);
}

async function getMember(userId)
{
    const [rows] = await pool.query(
        'SELECT user_id, role, is_kicked FROM users WHERE user_id = ?',
        [userId]
    );

    return rows[0] || null;
}

async function findEditor(roomId, codeId)
{
    const [rows] = await pool.query(
        'SELECT code_id, created_by FROM codes WHERE code_id = ? AND room_id = ?',
        [codeId, roomId]
    );

    return rows[0] || null;
}

function canChangeEditor(member, createdBy)
{
    if (!member || member.is_kicked)
    {
        return false;
    }

    if (member.role === 'admin')
    {
        return true;
    }

    return member.role === 'mod' && createdBy === member.user_id;
}

function toEditor(row)
{
    return { codeId: row.code_id, title: row.title, content: row.content, createdBy: row.created_by };
}

function readCodeId(data)
{
    const codeId = data ? Number(data.codeId) : 0;
    return Number.isInteger(codeId) && codeId > 0 ? codeId : 0;
}

function cancelSave(codeId)
{
    const pending = saveTimers.get(codeId);

    if (pending)
    {
        clearTimeout(pending.timer);
        saveTimers.delete(codeId);
    }
}

function scheduleSave(codeId, changes)
{
    const pending = saveTimers.get(codeId) || { changes: {}, timer: null };

    Object.assign(pending.changes, changes);
    clearTimeout(pending.timer);

    pending.timer = setTimeout(async () =>
    {
        saveTimers.delete(codeId);

        const fields = [];
        const values = [];

        if (pending.changes.title !== undefined)
        {
            fields.push('title = ?');
            values.push(pending.changes.title);
        }

        if (pending.changes.content !== undefined)
        {
            fields.push('content = ?');
            values.push(pending.changes.content);
        }

        if (fields.length === 0)
        {
            return;
        }

        values.push(codeId);

        try
        {
            await pool.query('UPDATE codes SET ' + fields.join(', ') + ' WHERE code_id = ?', values);
        }
        catch (error)
        {
            console.error('Save editor error:', error.message);
        }
    }, SAVE_DELAY_MS);

    saveTimers.set(codeId, pending);
}

io.on('connection', async (socket) =>
{
    const roomId = socket.data.roomId;
    const userId = socket.data.userId;
    const channel = 'room:' + roomId;

    socket.join(channel);
    socket.join('user:' + userId);

    let counted = false;

    socket.on('disconnect', () =>
    {
        if (counted)
        {
            removePresence(roomId, userId);
        }
    });

    try
    {
        const member = await getMember(userId);

        if (!member || member.is_kicked)
        {
            socket.disconnect(true);
            return;
        }

        const [rows] = await pool.query(
            'SELECT code_id, title, content, created_by FROM codes WHERE room_id = ? ORDER BY code_id',
            [roomId]
        );

        socket.emit('init', { userId: userId, role: member.role, editors: rows.map(toEditor) });

        if (socket.disconnected)
        {
            return;
        }

        if (member.role === 'admin')
        {
            socket.join('admin:' + roomId);
        }

        counted = true;
        addPresence(roomId, userId);
    }
    catch (error)
    {
        console.error('Socket init error:', error.message);
        socket.emit('editor-error', 'Could not load the editors.');
    }

    socket.on('editor-add', async () =>
    {
        try
        {
            const member = await getMember(userId);

            if (!member || member.is_kicked || (member.role !== 'admin' && member.role !== 'mod'))
            {
                return socket.emit('editor-error', 'You are not allowed to add editors.');
            }

            const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM codes WHERE room_id = ?', [roomId]);

            if (countRows[0].total >= MAX_EDITORS)
            {
                return socket.emit('editor-error', 'This room already has ' + MAX_EDITORS + ' editors.');
            }

            const [result] = await pool.query(
                'INSERT INTO codes (room_id, title, content, created_by) VALUES (?, ?, ?, ?)',
                [roomId, 'Untitled', '', userId]
            );

            io.to(channel).emit('editor-added',
            {
                codeId: result.insertId,
                title: 'Untitled',
                content: '',
                createdBy: userId
            });
        }
        catch (error)
        {
            console.error('Add editor error:', error.message);
            socket.emit('editor-error', 'Could not add the editor.');
        }
    });

    socket.on('editor-update', async (data) =>
    {
        const codeId = readCodeId(data);
        const changes = {};

        if (!codeId || (data.title === undefined && data.content === undefined))
        {
            return;
        }

        if (data.title !== undefined)
        {
            if (typeof data.title !== 'string' || data.title.length > MAX_TITLE_LENGTH)
            {
                return socket.emit('editor-error', 'Title can be at most ' + MAX_TITLE_LENGTH + ' characters.');
            }

            changes.title = data.title.replace(/[\r\n]/g, ' ');
        }

        if (data.content !== undefined)
        {
            if (typeof data.content !== 'string' || data.content.length > MAX_CODE_LENGTH)
            {
                return socket.emit('editor-error', 'Code is too long.');
            }

            changes.content = data.content;
        }

        try
        {
            const member = await getMember(userId);
            const editor = await findEditor(roomId, codeId);

            if (!editor || !canChangeEditor(member, editor.created_by))
            {
                return socket.emit('editor-error', 'You are not allowed to change this editor.');
            }

            socket.to(channel).emit('editor-updated', Object.assign({ codeId: codeId }, changes));
            scheduleSave(codeId, changes);
        }
        catch (error)
        {
            console.error('Update editor error:', error.message);
            socket.emit('editor-error', 'Could not update the editor.');
        }
    });

    socket.on('editor-delete', async (data) =>
    {
        const codeId = readCodeId(data);

        if (!codeId)
        {
            return;
        }

        try
        {
            const member = await getMember(userId);
            const editor = await findEditor(roomId, codeId);

            if (!editor || !canChangeEditor(member, editor.created_by))
            {
                return socket.emit('editor-error', 'You are not allowed to delete this editor.');
            }

            cancelSave(codeId);
            await pool.query('DELETE FROM codes WHERE code_id = ? AND room_id = ?', [codeId, roomId]);
            io.to(channel).emit('editor-deleted', { codeId: codeId });
        }
        catch (error)
        {
            console.error('Delete editor error:', error.message);
            socket.emit('editor-error', 'Could not delete the editor.');
        }
    });
    
    socket.on('editor-delete-all', async () =>
    {
        try
        {
            const member = await getMember(userId);

            if (!member || member.is_kicked || member.role !== 'admin')
            {
                return socket.emit('editor-error', 'Only the Admin can delete all editors.');
            }

            const [rows] = await pool.query('SELECT code_id FROM codes WHERE room_id = ?', [roomId]);

            rows.forEach((row) =>
            {
                cancelSave(row.code_id);
            });

            await pool.query('DELETE FROM codes WHERE room_id = ?', [roomId]);
            io.to(channel).emit('editors-cleared');
        }
        catch (error)
        {
            console.error('Delete all editors error:', error.message);
            socket.emit('editor-error', 'Could not delete the editors.');
        }
    });

    async function findTarget(data)
    {
        const targetId = data ? Number(data.userId) : 0;

        if (!Number.isInteger(targetId) || targetId <= 0)
        {
            return null;
        }

        const [rows] = await pool.query(
            'SELECT user_id, role, is_kicked FROM users WHERE user_id = ? AND room_id = ?',
            [targetId, roomId]
        );

        return rows[0] || null;
    }

    socket.on('user-set-role', async (data) =>
    {
        try
        {
            const member = await getMember(userId);

            if (!member || member.is_kicked || member.role !== 'admin')
            {
                return socket.emit('editor-error', 'Only the Admin can change roles.');
            }

            const newRole = data ? data.role : '';

            if (newRole !== 'mod' && newRole !== 'member')
            {
                return socket.emit('editor-error', 'Invalid role.');
            }

            const target = await findTarget(data);

            if (!target || target.is_kicked || target.role === 'admin')
            {
                return socket.emit('editor-error', 'You cannot change this person.');
            }

            await pool.query('UPDATE users SET role = ? WHERE user_id = ?', [newRole, target.user_id]);

            io.to('user:' + target.user_id).emit('role-changed');
            sendPresence(roomId);
        }
        catch (error)
        {
            console.error('Set role error:', error.message);
            socket.emit('editor-error', 'Could not change the role.');
        }
    });

    socket.on('user-kick', async (data) =>
    {
        try
        {
            const member = await getMember(userId);

            if (!member || member.is_kicked || member.role !== 'admin')
            {
                return socket.emit('editor-error', 'Only the Admin can kick people.');
            }

            const target = await findTarget(data);

            if (!target || target.is_kicked || target.role === 'admin')
            {
                return socket.emit('editor-error', 'You cannot kick this person.');
            }

            await pool.query('UPDATE users SET is_kicked = 1 WHERE user_id = ?', [target.user_id]);

            const online = presence.get(roomId);
            const entry = online ? online.get(target.user_id) : null;

            if (entry)
            {
                clearTimeout(entry.timer);
                online.delete(target.user_id);
            }

            io.to('user:' + target.user_id).emit('kicked');
            io.in('user:' + target.user_id).disconnectSockets(true);
            sendPresence(roomId);
        }
        catch (error)
        {
            console.error('Kick error:', error.message);
            socket.emit('editor-error', 'Could not kick this person.');
        }
    }); 
    
    socket.on('room-set-time', async (data) =>
    {
        try
        {
            const member = await getMember(userId);

            if (!member || member.is_kicked || member.role !== 'admin')
            {
                return socket.emit('editor-error', 'Only the Admin can change the room time.');
            }

            const minutes = data ? Number(data.minutes) : 0;

            if (!Number.isInteger(minutes) || minutes < MIN_ROOM_MINUTES || minutes > MAX_ROOM_MINUTES)
            {
                return socket.emit('editor-error', 'Time must be between 5 minutes and 7 days.');
            }

            await pool.query(
                'UPDATE rooms SET expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE room_id = ?',
                [minutes, roomId]
            );

            const [rows] = await pool.query(
                'SELECT UNIX_TIMESTAMP(expires_at) AS expires_unix FROM rooms WHERE room_id = ?',
                [roomId]
            );

            if (rows[0])
            {
                io.to(channel).emit('time-changed',
                {
                    expiresAt: Number(rows[0].expires_unix) * 1000,
                    serverNow: Date.now()
                });
            }
        }
        catch (error)
        {
            console.error('Set time error:', error.message);
            socket.emit('editor-error', 'Could not change the room time.');
        }
    });   
});

async function removeExpiredRooms()
{
    try
    {
        const [rooms] = await pool.query('SELECT room_id FROM rooms WHERE expires_at <= NOW()');

        for (const room of rooms)
        {
            const roomId = room.room_id;
            const [codes] = await pool.query('SELECT code_id FROM codes WHERE room_id = ?', [roomId]);

            codes.forEach((code) =>
            {
                cancelSave(code.code_id);
            });

            io.to('room:' + roomId).emit('room-expired');
            await pool.query('DELETE FROM rooms WHERE room_id = ?', [roomId]);

            const online = presence.get(roomId);

            if (online)
            {
                online.forEach((entry) =>
                {
                    clearTimeout(entry.timer);
                });

                presence.delete(roomId);
            }

            setTimeout(() =>
            {
                io.in('room:' + roomId).disconnectSockets(true);
            }, 1000);

            console.log('Removed expired room ' + roomId);
        }
    }
    catch (error)
    {
        console.error('Expiry sweep error:', error.message);
    }
}

removeExpiredRooms();
setInterval(removeExpiredRooms, EXPIRY_CHECK_MS);

const port = process.env.PORT || 3000;

server.listen(port, '0.0.0.0', () =>
{
    console.log('CodeHouse server running');
    console.log('Home page:   http://localhost:' + port);
    console.log('Health test: http://localhost:' + port + '/api/health');
});