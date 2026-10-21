const TOKEN_KEY = 'codehouseToken';
const THEME_KEY = 'codehouseTheme';
const NOTICE_KEY = 'codehouseNotice';
const NOTICE_TYPE_KEY = 'codehouseNoticeType';
const PREFILL_KEY = 'codehouseJoinRoom';

const statusBox = document.getElementById('status');
const themeToggle = document.getElementById('themeToggle');
const createForm = document.getElementById('createForm');
const joinForm = document.getElementById('joinForm');

function getToken()
{
    let token = localStorage.getItem(TOKEN_KEY);

    if (!token || !/^[a-f0-9]{32}$/.test(token))
    {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);

        token = Array.from(bytes, function (byte)
        {
            return byte.toString(16).padStart(2, '0');
        }).join('');

        localStorage.setItem(TOKEN_KEY, token);
    }

    return token;
}

function showStatus(message, type)
{
    statusBox.textContent = message;
    statusBox.className = 'status ' + type;
    statusBox.hidden = false;
}

async function postJson(url, data)
{
    try
    {
        const response = await fetch(url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await response.json();
        return { ok: response.ok, data: result };
    }
    catch (error)
    {
        return { ok: false, data: { error: 'Cannot reach the server. Check your connection.' } };
    }
}

function applyTheme(theme)
{
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
    localStorage.setItem(THEME_KEY, theme);
}

themeToggle.addEventListener('click', function ()
{
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

createForm.addEventListener('submit', async function (event)
{
    event.preventDefault();

    const button = createForm.querySelector('button');
    button.disabled = true;

    const result = await postJson('/api/rooms/create',
    {
        roomName: document.getElementById('createName').value,
        roomPassword: document.getElementById('createPassword').value,
        adminToken: getToken()
    });

    if (!result.ok)
    {
        button.disabled = false;
        showStatus(result.data.error || 'Something went wrong.', 'error');
        return;
    }

    window.location.href = '/' + result.data.roomId;
});

joinForm.addEventListener('submit', async function (event)
{
    event.preventDefault();

    const button = joinForm.querySelector('button');
    button.disabled = true;

    const result = await postJson('/api/rooms/join',
    {
        roomId: document.getElementById('joinId').value,
        roomPassword: document.getElementById('joinPassword').value,
        guestToken: getToken()
    });

    if (!result.ok)
    {
        button.disabled = false;
        showStatus(result.data.error || 'Something went wrong.', 'error');
        return;
    }

    window.location.href = '/' + result.data.roomId;
});

applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');

const savedNotice = sessionStorage.getItem(NOTICE_KEY);
const savedNoticeType = sessionStorage.getItem(NOTICE_TYPE_KEY) || 'error';
const prefillRoom = sessionStorage.getItem(PREFILL_KEY);

if (savedNotice)
{
    sessionStorage.removeItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_TYPE_KEY);
    showStatus(savedNotice, savedNoticeType);
}

if (prefillRoom)
{
    sessionStorage.removeItem(PREFILL_KEY);
    document.getElementById('joinId').value = prefillRoom;
    document.getElementById('joinPassword').focus();
}


const roomsTable = document.getElementById('roomsTable');
const roomsBody = document.getElementById('roomsBody');
const roomsEmpty = document.getElementById('roomsEmpty');

const roleLabels = { admin: 'Admin', mod: 'Mod', member: 'Member' };

function formatTimeLeft(totalSeconds)
{
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    return hours + 'h ' + minutes + 'm';
}

function makeCell(text)
{
    const cell = document.createElement('td');
    cell.textContent = text;
    return cell;
}

function makeActionCell(room)
{
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';

    if (room.is_kicked)
    {
        button.className = 'btn btn-danger';
        button.textContent = 'Kicked';
        button.disabled = true;
    }
    else
    {
        button.className = 'btn';
        button.textContent = 'Join';
        button.addEventListener('click', function ()
        {
            window.location.href = '/' + room.room_id;
        });
    }

    cell.appendChild(button);
    return cell;
}

function showRooms(rooms)
{
    roomsBody.textContent = '';

    if (rooms.length === 0)
    {
        roomsTable.hidden = true;
        roomsEmpty.hidden = false;
        return;
    }

    roomsEmpty.hidden = true;
    roomsTable.hidden = false;

    rooms.forEach(function (room, index)
    {
        const row = document.createElement('tr');

        row.appendChild(makeCell(String(index + 1)));
        row.appendChild(makeCell(room.room_id));
        row.appendChild(makeCell(room.room_name));
        row.appendChild(makeCell(roleLabels[room.role] || room.role));
        row.appendChild(makeCell(formatTimeLeft(room.seconds_left)));
        row.appendChild(makeActionCell(room));

        roomsBody.appendChild(row);
    });
}

async function loadMyRooms()
{
    const result = await postJson('/api/rooms/mine', { guestToken: getToken() });

    if (result.ok)
    {
        showRooms(result.data.rooms);
    }
}

loadMyRooms();
setInterval(loadMyRooms, 30000);