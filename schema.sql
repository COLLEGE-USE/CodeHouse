CREATE DATABASE IF NOT EXISTS codehouse;
USE codehouse;

CREATE TABLE IF NOT EXISTS rooms (
    room_id CHAR(4) NOT NULL,
    room_name VARCHAR(50) NOT NULL,
    room_password VARCHAR(50) NOT NULL,
    expires_at DATETIME NOT NULL,
    next_guest_number INT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id),
    INDEX idx_rooms_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    user_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id CHAR(4) NOT NULL,
    guest_token VARCHAR(64) NOT NULL,
    guest_name VARCHAR(20) NOT NULL,
    guest_number INT UNSIGNED NOT NULL,
    role ENUM('admin', 'mod', 'member') NOT NULL DEFAULT 'member',
    is_kicked TINYINT(1) NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    UNIQUE KEY uq_users_room_token (room_id, guest_token),
    UNIQUE KEY uq_users_room_number (room_id, guest_number),
    INDEX idx_users_token (guest_token),
    CONSTRAINT fk_users_room FOREIGN KEY (room_id)
        REFERENCES rooms (room_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS codes (
    code_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id CHAR(4) NOT NULL,
    title VARCHAR(100) NOT NULL DEFAULT 'Untitled',
    content LONGTEXT NOT NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (code_id),
    INDEX idx_codes_room (room_id),
    CONSTRAINT fk_codes_room FOREIGN KEY (room_id)
        REFERENCES rooms (room_id) ON DELETE CASCADE,
    CONSTRAINT fk_codes_creator FOREIGN KEY (created_by)
        REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;