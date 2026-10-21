const TOKEN_KEY = 'codehouseToken';
const THEME_KEY = 'codehouseTheme';
const NOTICE_KEY = 'codehouseNotice';
const NOTICE_TYPE_KEY = 'codehouseNoticeType';
const PREFILL_KEY = 'codehouseJoinRoom';

const roomNameBox = document.getElementById('roomName');
const roomIdBox = document.getElementById('roomId');
const timeLeftBox = document.getElementById('timeLeft');
const roleBadge = document.getElementById('roleBadge');
const guestNameBox = document.getElementById('guestName');
const passwordBox = document.getElementById('passwordBox');
const passwordText = document.getElementById('passwordText');
const togglePasswordButton = document.getElementById('togglePasswordButton');
const copyPasswordButton = document.getElementById('copyPasswordButton');
const copyIdButton = document.getElementById('copyIdButton');
const topIdBox = document.getElementById('topIdBox');
const accessIdText = document.getElementById('accessIdText');
const accessCopyIdButton = document.getElementById('accessCopyIdButton');
const themeToggle = document.getElementById('themeToggle');
const leaveButton = document.getElementById('leaveButton');
const closeButton = document.getElementById('closeButton');
const closeConfirm = document.getElementById('closeConfirm');
const closeYes = document.getElementById('closeYes');
const closeNo = document.getElementById('closeNo');
const statusBox = document.getElementById('status');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const toolbar = document.getElementById('toolbar');
const addEditorButton = document.getElementById('addEditorButton');
const noEditors = document.getElementById('noEditors');
const editorGrid = document.getElementById('editorGrid');
const deleteAllButton = document.getElementById('deleteAllButton');
const deleteAllConfirm = document.getElementById('deleteAllConfirm');
const deleteAllYes = document.getElementById('deleteAllYes');
const deleteAllNo = document.getElementById('deleteAllNo');
const layout = document.getElementById('layout');
const sidePanel = document.getElementById('sidePanel');
const onlineCount = document.getElementById('onlineCount');
const onlineList = document.getElementById('onlineList');
const seeAllButton = document.getElementById('seeAllButton');
const changeTimeButton = document.getElementById('changeTimeButton');
const timeForm = document.getElementById('timeForm');
const timeChips = document.getElementById('timeChips');
const customTime = document.getElementById('customTime');
const customHours = document.getElementById('customHours');
const customMinutes = document.getElementById('customMinutes');
const setTimeButton = document.getElementById('setTimeButton');
const cancelTimeButton = document.getElementById('cancelTimeButton');

const roleLabels = { admin: 'Admin', mod: 'Mod', member: 'Member' };
const HIDDEN_PASSWORD = '••••••';
const SEND_DELAY_MS = 40;
const MAX_TITLE_LENGTH = 40;
const ONLINE_PREVIEW = 5;
const MIN_ROOM_MINUTES = 5;
const MAX_ROOM_MINUTES = 10080;

const roomId = window.location.pathname.slice(1).toUpperCase();
const editors = new Map();
const sendState = new Map();

let roomPassword = '';
let passwordVisible = false;
let statusTimer = null;
let socket = null;
let myUserId = 0;
let myRole = '';
let onlineUsers = [];
let showAllOnline = false;
let selectedMinutes = 0;
let countdownTimer = null;

function goHome(message, type)
{
    if (message)
    {
        sessionStorage.setItem(NOTICE_KEY, message);
        sessionStorage.setItem(NOTICE_TYPE_KEY, type || 'error');
    }

    window.location.href = '/';
}

function showStatus(message, type)
{
    statusBox.textContent = message;
    statusBox.className = 'status ' + type;
    statusBox.hidden = false;

    clearTimeout(statusTimer);
    statusTimer = setTimeout(function ()
    {
        statusBox.hidden = true;
    }, 2500);
}

async function copyText(text)
{
    try
    {
        if (navigator.clipboard && window.isSecureContext)
        {
            await navigator.clipboard.writeText(text);
            return true;
        }
    }
    catch (error)
    {
        console.log('Clipboard API not available, using fallback.');
    }

    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();

    let copied = false;

    try
    {
        copied = document.execCommand('copy');
    }
    catch (error)
    {
        copied = false;
    }

    document.body.removeChild(box);
    return copied;
}

async function copyWithMessage(text, label)
{
    const copied = await copyText(text);

    if (copied)
    {
        showStatus(label + ' copied.', 'success');
    }
    else
    {
        showStatus('Could not copy. Please copy it by hand.', 'error');
    }
}

function applyTheme(theme)
{
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
    localStorage.setItem(THEME_KEY, theme);
}

function formatTime(totalSeconds)
{
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds].map(function (part)
    {
        return String(part).padStart(2, '0');
    }).join(':');
}

function startCountdown(expiresAt, serverNow)
{
    clearInterval(countdownTimer);

    const endTime = expiresAt - (serverNow - Date.now());

    function tick()
    {
        const remaining = Math.ceil((endTime - Date.now()) / 1000);

        if (remaining <= 0)
        {
            clearInterval(countdownTimer);
            goHome('The room time is over.');
            return;
        }

        timeLeftBox.textContent = formatTime(remaining);
    }

    tick();
    countdownTimer = setInterval(tick, 250);
}

function showPasswordState()
{
    passwordText.textContent = passwordVisible ? roomPassword : HIDDEN_PASSWORD;
    togglePasswordButton.textContent = passwordVisible ? 'Hide' : 'Show';
}

function showAdminPassword(password)
{
    roomPassword = password;
    passwordBox.hidden = false;

    if (password === '')
    {
        passwordText.textContent = 'None';
        togglePasswordButton.hidden = true;
        copyPasswordButton.hidden = true;
        return;
    }

    showPasswordState();
}

function canChange(createdBy)
{
    return myRole === 'admin' || (myRole === 'mod' && createdBy === myUserId);
}

function updateEmptyNote()
{
    noEditors.hidden = editors.size > 0;
}

function queueSend(codeId, field)
{
    const state = sendState.get(codeId) || { fields: {}, timer: null };
    state.fields[field] = true;

    if (state.timer)
    {
        sendState.set(codeId, state);
        return;
    }

    state.timer = setTimeout(function ()
    {
        sendState.delete(codeId);

        const parts = editors.get(codeId);

        if (!parts || !socket)
        {
            return;
        }

        const payload = { codeId: codeId };

        if (state.fields.title)
        {
            payload.title = parts.titleInput.value;
        }

        if (state.fields.content)
        {
            payload.content = parts.codeBox.value;
        }

        socket.emit('editor-update', payload);
    }, SEND_DELAY_MS);

    sendState.set(codeId, state);
}

function setValueKeepCaret(box, value)
{
    if (box.value === value)
    {
        return;
    }

    const hadFocus = document.activeElement === box;
    const start = box.selectionStart;
    const end = box.selectionEnd;

    box.value = value;

    if (hadFocus)
    {
        box.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
    }
}

function handleTab(event, codeBox)
{
    if (event.key !== 'Tab' || event.shiftKey)
    {
        return;
    }

    event.preventDefault();
    codeBox.setRangeText('    ', codeBox.selectionStart, codeBox.selectionEnd, 'end');
    codeBox.dispatchEvent(new Event('input'));
}

function makeDeleteButton(codeId)
{
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-danger btn-small';
    button.textContent = 'Delete';

    button.addEventListener('click', function ()
    {
        if (button.dataset.sure === '1')
        {
            socket.emit('editor-delete', { codeId: codeId });
            return;
        }

        button.dataset.sure = '1';
        button.textContent = 'Sure?';

        setTimeout(function ()
        {
            button.dataset.sure = '';
            button.textContent = 'Delete';
        }, 3000);
    });

    return button;
}

function createEditorCard(editor)
{
    const editable = canChange(editor.createdBy);

    const card = document.createElement('div');
    card.className = 'editor-card';

    const dotRow = document.createElement('div');
    dotRow.className = 'dot-row';

    ['red', 'yellow', 'green'].forEach(function (color)
    {
        const dot = document.createElement('span');
        dot.className = 'traffic ' + color;
        dotRow.appendChild(dot);
    });

    const head = document.createElement('div');
    head.className = 'editor-head';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'editor-title';
    titleInput.maxLength = MAX_TITLE_LENGTH;
    titleInput.placeholder = 'Title';
    titleInput.value = editor.title;
    titleInput.readOnly = !editable;
    titleInput.autocomplete = 'off';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn btn-small';
    copyButton.textContent = 'Copy code';

    head.appendChild(titleInput);
    head.appendChild(copyButton);

    if (editable)
    {
        head.appendChild(makeDeleteButton(editor.codeId));
    }

    const codeBox = document.createElement('textarea');
    codeBox.className = 'code-box';
    codeBox.value = editor.content;
    codeBox.readOnly = !editable;
    codeBox.spellcheck = false;
    codeBox.setAttribute('wrap', 'off');
    codeBox.setAttribute('autocomplete', 'off');

    copyButton.addEventListener('click', function ()
    {
        copyWithMessage(codeBox.value, 'Code');
    });

    if (editable)
    {
        titleInput.addEventListener('input', function ()
        {
            queueSend(editor.codeId, 'title');
        });

        codeBox.addEventListener('input', function ()
        {
            queueSend(editor.codeId, 'content');
        });

        codeBox.addEventListener('keydown', function (event)
        {
            handleTab(event, codeBox);
        });
    }

    card.appendChild(dotRow);
    card.appendChild(head);
    card.appendChild(codeBox);

    editors.set(editor.codeId, { card: card, titleInput: titleInput, codeBox: codeBox });
    return card;
}

function renderAllEditors(list)
{
    editorGrid.textContent = '';
    editors.clear();

    list.forEach(function (editor)
    {
        editorGrid.appendChild(createEditorCard(editor));
    });

    updateEmptyNote();
}

function removeEditor(codeId)
{
    const parts = editors.get(codeId);

    if (!parts)
    {
        return;
    }

    const state = sendState.get(codeId);

    if (state)
    {
        clearTimeout(state.timer);
        sendState.delete(codeId);
    }

    parts.card.remove();
    editors.delete(codeId);
    updateEmptyNote();
}

function makeKickButton(userId)
{
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-danger btn-small';
    button.textContent = 'Kick';

    button.addEventListener('click', function ()
    {
        if (button.dataset.sure === '1')
        {
            socket.emit('user-kick', { userId: userId });
            return;
        }

        button.dataset.sure = '1';
        button.textContent = 'Sure?';

        setTimeout(function ()
        {
            button.dataset.sure = '';
            button.textContent = 'Kick';
        }, 3000);
    });

    return button;
}

function makeRoleSelect(user)
{
    const select = document.createElement('select');
    select.className = 'role-select';

    [['member', 'Member'], ['mod', 'Mod']].forEach(function (option)
    {
        const item = document.createElement('option');
        item.value = option[0];
        item.textContent = option[1];
        select.appendChild(item);
    });

    select.value = user.role;

    select.addEventListener('change', function ()
    {
        socket.emit('user-set-role', { userId: user.userId, role: select.value });
    });

    return select;
}

function makeOnlineItem(user)
{
    const item = document.createElement('li');
    item.className = 'online-item';

    const name = document.createElement('span');
    name.textContent = user.guestName;
    item.appendChild(name);

    if (user.role === 'admin')
    {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Admin';
        item.appendChild(badge);
        return item;
    }

    const actions = document.createElement('span');
    actions.className = 'online-actions';
    actions.appendChild(makeRoleSelect(user));
    actions.appendChild(makeKickButton(user.userId));
    item.appendChild(actions);

    return item;
}

function renderOnline()
{
    const total = onlineUsers.length;
    const needsButton = total > ONLINE_PREVIEW;

    if (!needsButton)
    {
        showAllOnline = false;
    }

    const visibleUsers = showAllOnline ? onlineUsers : onlineUsers.slice(0, ONLINE_PREVIEW);

    onlineCount.textContent = total;
    onlineList.textContent = '';

    visibleUsers.forEach(function (user)
    {
        onlineList.appendChild(makeOnlineItem(user));
    });

    onlineList.classList.toggle('expanded', showAllOnline);
    seeAllButton.hidden = !needsButton;
    seeAllButton.textContent = showAllOnline ? 'Show less' : 'See all (' + total + ')';
}
function getChosenMinutes()
{
    if (selectedMinutes === 'custom')
    {
        const hours = Number(customHours.value) || 0;
        const minutes = Number(customMinutes.value) || 0;
        return hours * 60 + minutes;
    }

    return selectedMinutes;
}

function updateSetButton()
{
    const total = getChosenMinutes();
    setTimeButton.disabled = !(Number.isInteger(total) && total >= MIN_ROOM_MINUTES && total <= MAX_ROOM_MINUTES);
}

function closeTimeForm()
{
    selectedMinutes = 0;
    customHours.value = '';
    customMinutes.value = '';
    customTime.hidden = true;
    timeForm.hidden = true;
    changeTimeButton.hidden = false;

    Array.from(timeChips.children).forEach(function (chip)
    {
        chip.classList.remove('selected');
    });

    updateSetButton();
}

function setConnection(state, text)
{
    connDot.className = 'dot ' + state;
    connText.textContent = text;
}

function connectSocket()
{
    socket = io({ auth: { roomId: roomId, guestToken: localStorage.getItem(TOKEN_KEY) } });

    socket.on('connect', function ()
    {
        setConnection('on', 'Connected');
    });

    socket.on('disconnect', function ()
    {
        setConnection('wait', 'Reconnecting...');
    });

    socket.on('connect_error', function (error)
    {
        if (error.message === 'no-access')
        {
            goHome('You do not have access to this room.');
            return;
        }

        setConnection('off', 'Connection problem');
    });

    socket.on('init', function (data)
    {
        myUserId = data.userId;
        myRole = data.role;
        toolbar.hidden = !(myRole === 'admin' || myRole === 'mod');
        deleteAllButton.hidden = myRole !== 'admin';

        if (myRole === 'admin')
        {
            sidePanel.hidden = false;
            layout.classList.add('has-side');
        }

        renderAllEditors(data.editors);
    });

    socket.on('presence', function (data)
    {
        onlineUsers = data.users;
        renderOnline();
    });

    socket.on('editor-added', function (editor)
    {
        if (editors.has(editor.codeId))
        {
            return;
        }

        editorGrid.appendChild(createEditorCard(editor));
        updateEmptyNote();

        if (editor.createdBy === myUserId)
        {
            editors.get(editor.codeId).codeBox.focus();
        }
    });

    socket.on('editor-updated', function (data)
    {
        const parts = editors.get(data.codeId);

        if (!parts)
        {
            return;
        }

        if (data.title !== undefined)
        {
            setValueKeepCaret(parts.titleInput, data.title);
        }

        if (data.content !== undefined)
        {
            setValueKeepCaret(parts.codeBox, data.content);
        }
    });

    socket.on('editor-deleted', function (data)
    {
        removeEditor(data.codeId);
    });

    socket.on('editors-cleared', function ()
    {
        Array.from(editors.keys()).forEach(function (codeId)
        {
            removeEditor(codeId);
        });

        deleteAllConfirm.hidden = true;
        showStatus('All editors were deleted.', 'success');
    });

    socket.on('room-expired', function ()
    {
        goHome('The room time is over.', 'info');
    });

    socket.on('time-changed', function (data)
    {
        startCountdown(data.expiresAt, data.serverNow);
        showStatus('The room time was changed.', 'info');
    });

    socket.on('role-changed', function ()
    {
        window.location.reload();
    });

    socket.on('kicked', function ()
    {
        goHome('You were removed from this room.');
    });
    

    socket.on('editor-error', function (message)
    {
        showStatus(message, 'error');
    });

    socket.on('room-closed', function ()
    {
        if (roleBadge.textContent === 'Admin')
        {
            return;
        }

        goHome('The Admin closed the room.', 'info');
    });
}

function showRoom(result)
{
    document.title = result.roomName + ' - CodeHouse';
    roomNameBox.textContent = result.roomName;
    roomIdBox.textContent = result.roomId;
    roleBadge.textContent = roleLabels[result.role] || result.role;

    if (result.role === 'admin')
    {
        closeButton.hidden = false;
        showAdminPassword(result.roomPassword || '');
        topIdBox.hidden = true;
        accessIdText.textContent = result.roomId;
    }
    else
    {
        guestNameBox.textContent = result.guestName;
        guestNameBox.hidden = false;
    }

    startCountdown(result.expiresAt, result.serverNow);
    connectSocket();
}

async function tryAutoJoin(token)
{
    try
    {
        const response = await fetch('/api/rooms/open',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: roomId, guestToken: token })
        });

        const result = await response.json();

        if (response.ok && result.joined)
        {
            openRoom(false);
            return;
        }

        if (response.ok && result.notFound)
        {
            goHome('Room does not exist or was closed.');
            return;
        }

        if (response.ok && result.needsPassword)
        {
            sessionStorage.setItem(PREFILL_KEY, roomId);
            goHome('Enter the password to join room ' + roomId + '.', 'info');
            return;
        }

        goHome(result.error || 'Could not open the room.');
    }
    catch (error)
    {
        goHome('Cannot reach the server. Check your connection.');
    }
}

async function openRoom(allowAutoJoin)
{
    const token = localStorage.getItem(TOKEN_KEY);

    if (!token)
    {
        goHome('Open the home page and join the room first.');
        return;
    }

    try
    {
        const response = await fetch('/api/rooms/access',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: roomId, guestToken: token })
        });

        const result = await response.json();

        if (!response.ok)
        {
            if (result.notMember && allowAutoJoin)
            {
                await tryAutoJoin(token);
                return;
            }

            goHome(result.error || 'You do not have access to this room.');
            return;
        }

        showRoom(result);
    }
    catch (error)
    {
        goHome('Cannot reach the server. Check your connection.');
    }
}

async function closeRoom()
{
    closeYes.disabled = true;

    try
    {
        const response = await fetch('/api/rooms/close',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: roomId, guestToken: localStorage.getItem(TOKEN_KEY) })
        });

        const result = await response.json();

        if (!response.ok)
        {
            closeYes.disabled = false;
            showStatus(result.error || 'Could not close the room.', 'error');
            return;
        }

        goHome('Room closed.', 'success');
    }
    catch (error)
    {
        closeYes.disabled = false;
        showStatus('Cannot reach the server. Check your connection.', 'error');
    }
}

themeToggle.addEventListener('click', function ()
{
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

leaveButton.addEventListener('click', function ()
{
    goHome();
});

accessCopyIdButton.addEventListener('click', function ()
{
    copyWithMessage(roomId, 'Room ID');
});

copyIdButton.addEventListener('click', function ()
{
    copyWithMessage(roomId, 'Room ID');
});

togglePasswordButton.addEventListener('click', function ()
{
    passwordVisible = !passwordVisible;
    showPasswordState();
});

copyPasswordButton.addEventListener('click', function ()
{
    copyWithMessage(roomPassword, 'Password');
});

closeButton.addEventListener('click', function ()
{
    closeConfirm.hidden = false;
});

closeNo.addEventListener('click', function ()
{
    closeConfirm.hidden = true;
});

closeYes.addEventListener('click', closeRoom);

seeAllButton.addEventListener('click', function ()
{
    showAllOnline = !showAllOnline;
    renderOnline();
});
changeTimeButton.addEventListener('click', function ()
{
    timeForm.hidden = false;
    changeTimeButton.hidden = true;
});

cancelTimeButton.addEventListener('click', closeTimeForm);

timeChips.addEventListener('click', function (event)
{
    const chip = event.target.closest('.chip');

    if (!chip)
    {
        return;
    }

    Array.from(timeChips.children).forEach(function (other)
    {
        other.classList.remove('selected');
    });

    chip.classList.add('selected');
    selectedMinutes = chip.dataset.minutes === 'custom' ? 'custom' : Number(chip.dataset.minutes);
    customTime.hidden = selectedMinutes !== 'custom';
    updateSetButton();
});

customHours.addEventListener('input', updateSetButton);
customMinutes.addEventListener('input', updateSetButton);

setTimeButton.addEventListener('click', function ()
{
    if (socket)
    {
        socket.emit('room-set-time', { minutes: getChosenMinutes() });
    }

    closeTimeForm();
});

deleteAllButton.addEventListener('click', function ()
{
    deleteAllConfirm.hidden = false;
});

deleteAllNo.addEventListener('click', function ()
{
    deleteAllConfirm.hidden = true;
});

deleteAllYes.addEventListener('click', function ()
{
    deleteAllConfirm.hidden = true;

    if (socket)
    {
        socket.emit('editor-delete-all');
    }
});

addEditorButton.addEventListener('click', function ()
{
    if (socket)
    {
        socket.emit('editor-add');
    }
});

applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
openRoom(true);