CODEHOUSE - PROJECT NOTES
=========================

What it is
----------
A small web app for college computer labs. An Admin creates a room, students
join with the Room ID and password, and everyone sees the shared code editors
live. Students copy the code and leave. No accounts, no logins.

Tech
----
Node.js, Express 5, Socket.IO 4, MySQL 8, plain HTML / CSS / JavaScript.
npm packages: express, socket.io, mysql2, dotenv, express-rate-limit.


FILES
-----
server.js              The whole backend: pages, API routes, live events,
                       auto-close of expired rooms.
package.json           Package list. "npm install" rebuilds node_modules.
.env                   Secrets and settings (never share this file).
schema.sql             Creates the database tables. Safe to run twice.
public/index.html      Home page: Create Room, Join Room, Your Rooms table.
public/script.js       Home page logic.
public/dashboard.html  Room page.
public/dashboard.js    Room page logic (live editors, Admin panel, timer).
public/style.css       All colors, spacing and layout.

(start.bat and a moving guide were planned but are on hold.)


DATABASE
--------
Database:  codehouse
Tables:    rooms    one row per room (id, name, password, expiry time)
           users    everyone who joined (role, guest name, kicked flag)
           codes    the code editors (title, content as LONGTEXT)
Deleting a room deletes its users and codes rows automatically (cascade).
The database was dropped and recreated with these names, so it holds only CodeHouse tables.
schema.sql has no DROP command. To start fresh, run DROP DATABASE codehouse; and then source schema.sql;

.env settings
-------------
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=...
DB_PASSWORD=...
DB_NAME=codehouse


HOW TO RUN
----------
1. Start MySQL (it runs as a Windows service).
2. In Command Prompt:
       cd /d D:\CodeHouse
       node server.js
3. Open http://localhost:3000
   Other devices on the same network use http://THIS-PC-IP:3000
   (find the IP with:  ipconfig  -> IPv4 Address)

After you change server.js:   stop (Ctrl+C) and start the server again.
After you change a public file: press Ctrl+F5 in the browser.
Typing check for server.js:     node --check server.js


ROLES AND WHAT THEY CAN DO
--------------------------
Admin   Creates the room. Add / edit / delete any editor, Delete All Editors,
        Close Room, Change Time, see the password and Room ID, see the online
        list, promote / demote to Mod, kick.
Mod     Add editors. Edit and delete only the editors they created. View and
        copy everything.
Member  View and copy only.

Every action is checked on the server, using the role stored in the database.
Hiding a button in the page is only for looks.


HOW PEOPLE ARE RECOGNISED
-------------------------
Each browser makes a random token (saved in the browser as "codehouseToken")
and sends it to the server. The server looks the token up in users.
 - Same browser, same room  -> same guest name and role.
 - Different browser/device -> a new guest (Guest1, Guest2, ...).
 - The Admin is tied to the browser that created the room. Clearing that
   browser's data loses Admin access to that room.
 - A kick blocks that token only. The person can still join from another
   browser as a new guest.


LIMITS (all at the top of server.js unless noted)
-------------------------------------------------
Default room time          120 minutes        DEFAULT_ROOM_MINUTES
Change Time range          5 min to 7 days    MIN/MAX_ROOM_MINUTES
Room name length           10                 MAX_ROOM_NAME_LENGTH
Room password length       10 (empty allowed) MAX_PASSWORD_LENGTH
Editors per room           20                 MAX_EDITORS
Editor title length        40                 MAX_TITLE_LENGTH
Code length per editor     100,000 chars      MAX_CODE_LENGTH
Save delay after typing    800 ms             SAVE_DELAY_MS
Offline grace period       10 seconds         PRESENCE_GRACE_MS
Expired-room check         every 30 seconds   EXPIRY_CHECK_MS
Wrong-password limit       10 per 5 minutes   joinLimiter
Online list preview        5 names            ONLINE_PREVIEW in dashboard.js
Home page input limits     maxlength in index.html (name 10, password 10, ID 4)


CHANGING THE LOOK
-----------------
All colors are variables at the top of public/style.css:
  :root                          dark theme (default)
  :root[data-theme="light"]      light theme
Change a value there and the whole site follows.
Current palette: background #0B1020, cards #151C2E, accent #5B8CFF.


API ROUTES (server.js)
----------------------
GET  /api/health          database check
POST /api/rooms/create    make a room (the creator becomes Admin)
POST /api/rooms/join      join with Room ID + password
POST /api/rooms/open      opens a pasted room link (joins directly if no password)
POST /api/rooms/access    checks who you are before the room page loads
POST /api/rooms/close     Admin only: delete the room
POST /api/rooms/mine      the "Your Rooms" table
GET  /XXXX                the room page (4 hex characters)

LIVE EVENTS (Socket.IO)
-----------------------
Browser -> server:  editor-add, editor-update, editor-delete,
                    editor-delete-all, user-set-role, user-kick, room-set-time
Server -> browser:  init, presence, editor-added, editor-updated,
                    editor-deleted, editors-cleared, editor-error,
                    role-changed, kicked, time-changed, room-expired,
                    room-closed
The server re-checks the sender's role in the database for every event.


SECURITY NOTES
--------------
 - MySQL listens only on this computer (bind-address 127.0.0.1,::1 in my.ini).
 - Room passwords are stored as PLAIN TEXT (a deliberate choice so the Admin
   can read them in the dashboard and in MySQL). Members never receive them.
 - Room IDs have only 4 characters, so rooms with an empty password can be
   joined by anyone who guesses the ID.
 - The app runs over plain http. On a shared network, traffic can be read by
   others on that network. HTTPS is a later phase.
 - The app connects to MySQL as root. A limited MySQL user was skipped.


NOT DONE YET
------------
 - HTTPS and public internet deployment (needs a plan first).
 - start.bat (one-click start).
 - Moving to another PC: steps were written but never tested.
 - Light theme colors in style.css may still be the old ones if that edit was
   skipped.
