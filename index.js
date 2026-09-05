const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions
const activeSessions = new Map();
const permanentSessions = new Map();
const sessionRefreshTracker = new Map();
const botSessions = new Map();

// WebSocket Server
const wss = new WebSocket.Server({ server });

// Auto recovery system
const autoRecovery = {
    crashes: 0,
    lastCrash: null,
    
    init() {
        process.on('uncaughtException', (error) => {
            console.error('⚠️ Uncaught Exception:', error);
            this.crashes++;
            this.lastCrash = Date.now();
            this.recoverAllSessions();
        });
        
        process.on('unhandledRejection', (error) => {
            console.error('⚠️ Unhandled Rejection:', error);
            this.crashes++;
            this.lastCrash = Date.now();
            this.recoverAllSessions();
        });
        
        // Auto recovery every 5 minutes
        setInterval(() => {
            this.checkAndRecoverSessions();
        }, 300000);
    },
    
    async recoverAllSessions() {
        try {
            console.log('🔄 Attempting auto recovery of all sessions...');
            
            // Load all permanent sessions
            const sessionDir = path.join(__dirname, 'sessions');
            if (!fs.existsSync(sessionDir)) return;
            
            const files = fs.readdirSync(sessionDir);
            const sessionFiles = files.filter(f => f.startsWith('permanent_') && f.endsWith('.json'));
            
            for (const file of sessionFiles) {
                try {
                    const sessionId = file.replace('permanent_', '').replace('.json', '');
                    
                    if (!activeSessions.has(sessionId)) {
                        const sessionData = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
                        
                        if (sessionData.appState && sessionData.type) {
                            console.log(`🔄 Recovering session: ${sessionId}`);
                            
                            const api = await new Promise((resolve) => {
                                silentLoginWithPermanentSession(sessionId, (fbApi) => {
                                    resolve(fbApi);
                                });
                            });
                            
                            if (api) {
                                if (sessionData.type === 'bot') {
                                    const botSystem = new AdvancedBotSystem(
                                        sessionId,
                                        api,
                                        sessionData.groupUID || 'unknown',
                                        sessionData.adminUID || sessionData.userId,
                                        sessionData.prefix || '/'
                                    );
                                    
                                    const sessionObj = {
                                        api,
                                        groupUID: sessionData.groupUID || 'unknown',
                                        adminUID: sessionData.adminUID || sessionData.userId,
                                        botSystem,
                                        status: 'active',
                                        startTime: Date.now(),
                                        userId: sessionData.userId,
                                        type: 'bot',
                                        prefix: sessionData.prefix || '/',
                                        originalStartTime: sessionData.createdAt || Date.now()
                                    };
                                    
                                    activeSessions.set(sessionId, sessionObj);
                                    botSessions.set(sessionId, botSystem);
                                    
                                    if (sessionData.botRunning) {
                                        botSystem.start();
                                    }
                                    
                                } else if (sessionData.type === 'enhanced_locking') {
                                    const lockSystem = new EnhancedSafePermanentLockSystem(
                                        sessionId,
                                        api,
                                        sessionData.groupUID || 'unknown',
                                        sessionData.userId
                                    );
                                    
                                    const sessionObj = {
                                        api,
                                        groupUID: sessionData.groupUID || 'unknown',
                                        lockSystem,
                                        status: 'active_24_7',
                                        startTime: Date.now(),
                                        userId: sessionData.userId,
                                        type: 'enhanced_locking',
                                        originalStartTime: sessionData.createdAt || Date.now()
                                    };
                                    
                                    activeSessions.set(sessionId, sessionObj);
                                    
                                    // Restore locks if they existed
                                    if (sessionData.lockedName) {
                                        lockSystem.lockedName = sessionData.lockedName;
                                        lockSystem.nameMonitorTime = sessionData.nameMonitorTime || 60000;
                                        lockSystem.startNameMonitoring();
                                    }
                                    
                                    if (sessionData.lockedNicknames) {
                                        lockSystem.lockedNicknames = new Map(sessionData.lockedNicknames);
                                        lockSystem.nicknameMonitorTime = sessionData.nicknameMonitorTime || 60000;
                                        lockSystem.startNicknameMonitoring();
                                    }
                                    
                                    if (sessionData.lockedPhotoData) {
                                        lockSystem.lockedPhotoData = sessionData.lockedPhotoData;
                                        lockSystem.photoMonitorTime = sessionData.photoMonitorTime || 60000;
                                        lockSystem.startPhotoMonitoring();
                                    }
                                }
                                
                                setupPermanent24_7Session(sessionId, api, sessionData.userId, sessionData.groupUID, sessionData.type);
                                console.log(`✅ Session recovered: ${sessionId}`);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`❌ Failed to recover session ${file}:`, error.message);
                }
            }
            
            console.log(`✅ Auto recovery completed. Recovered ${sessionFiles.length} sessions`);
        } catch (error) {
            console.error('❌ Auto recovery failed:', error.message);
        }
    },
    
    checkAndRecoverSessions() {
        for (const [sessionId, session] of activeSessions) {
            if (session.status === 'error' || session.status === 'stuck') {
                console.log(`🔄 Detected stuck session: ${sessionId}, attempting recovery...`);
                this.recoverSession(sessionId);
            }
        }
    },
    
    async recoverSession(sessionId) {
        try {
            const session = activeSessions.get(sessionId);
            if (!session) return;
            
            // Force logout and relogin
            if (session.api && typeof session.api.logout === 'function') {
                try {
                    session.api.logout(() => {});
                } catch (e) {}
            }
            
            // Reload from permanent session
            const sessionData = loadPermanentSession(sessionId);
            if (!sessionData) return;
            
            const api = await new Promise((resolve) => {
                silentLoginWithPermanentSession(sessionId, (fbApi) => {
                    resolve(fbApi);
                });
            });
            
            if (api) {
                session.api = api;
                session.status = 'active';
                session.lastRecovery = Date.now();
                
                if (session.botSystem) {
                    session.botSystem.api = api;
                    session.botSystem.setupMessageListener();
                }
                
                if (session.lockSystem) {
                    session.lockSystem.api = api;
                }
                
                console.log(`✅ Session ${sessionId} recovered successfully`);
            }
        } catch (error) {
            console.error(`❌ Failed to recover session ${sessionId}:`, error.message);
        }
    }
};

// Initialize auto recovery
autoRecovery.init();

// ==================== UTILITY FUNCTIONS ====================
function generateSessionId() {
    return crypto.randomBytes(5).toString('hex').toUpperCase();
}

// ==================== PERMANENT SESSION SYSTEM ====================
function savePermanentSession(sessionId, api, userId, type = 'messaging', additionalData = {}) {
    try {
        if (!api) return false;
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        if (!fs.existsSync(path.dirname(sessionPath))) {
            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        }
        
        const appState = api.getAppState();
        const sessionData = {
            sessionId,
            appState,
            userId,
            type,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            lastRefresh: Date.now(),
            ...additionalData
        };
        
        // Also save cookie to cookies.txt
        saveCookieToFile(sessionId, appState);
        
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        return true;
    } catch (error) {
        return false;
    }
}

function saveCookieToFile(sessionId, appState) {
    try {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const cookieString = JSON.stringify(appState);
        
        let cookies = [];
        if (fs.existsSync(cookiesPath)) {
            const content = fs.readFileSync(cookiesPath, 'utf8');
            cookies = content.split('\n').filter(line => line.trim() && !line.includes(sessionId));
        }
        
        // Keep only last 100 cookies
        cookies.unshift(`# ${sessionId} - ${new Date().toISOString()}`);
        cookies.unshift(cookieString);
        
        if (cookies.length > 200) {
            cookies = cookies.slice(0, 200);
        }
        
        fs.writeFileSync(cookiesPath, cookies.join('\n'));
    } catch (error) {
        // Silent error
    }
}

function loadPermanentSession(sessionId) {
    try {
        if (permanentSessions.has(sessionId)) {
            return permanentSessions.get(sessionId);
        }
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        if (fs.existsSync(sessionPath)) {
            const fileStats = fs.statSync(sessionPath);
            if (fileStats.size > 100) {
                const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                permanentSessions.set(sessionId, sessionData);
                return sessionData;
            }
        }
    } catch (error) {
        // NO CONSOLE LOGGING
    }
    return null;
}

function getSessionsByUserId(userId) {
    const sessions = [];
    for (const [sessionId, session] of permanentSessions) {
        if (session.userId === userId) {
            sessions.push({
                sessionId,
                type: session.type,
                createdAt: session.createdAt,
                lastUsed: session.lastUsed,
                lastRefresh: session.lastRefresh
            });
        }
    }
    return sessions;
}

// ==================== PERMANENT 24/7 NO AUTO LOGOUT SYSTEM ====================
function setupPermanent24_7Session(sessionId, api, userId, groupUID, type) {
    if (sessionRefreshTracker.has(sessionId)) {
        clearTimeout(sessionRefreshTracker.get(sessionId));
    }
    
    // 24/7 operation - never auto logout, only refresh for safety
    const refreshTimer = setTimeout(() => {
        refreshPermanentSession24_7(sessionId, api, userId, groupUID, type);
    }, 86400000); // 24 hours refresh for safety only
    
    sessionRefreshTracker.set(sessionId, refreshTimer);
}

function refreshPermanentSession24_7(sessionId, api, userId, groupUID, type) {
    try {
        const sessionData = loadPermanentSession(sessionId);
        if (!sessionData) return;
        
        const currentSession = activeSessions.get(sessionId);
        
        // Save current session state
        if (currentSession) {
            if (currentSession.botSystem) {
                sessionData.botRunning = currentSession.botSystem.isRunning;
                sessionData.botStatus = currentSession.botSystem.getStatus();
            }
            
            if (currentSession.lockSystem) {
                sessionData.lockedName = currentSession.lockSystem.lockedName;
                sessionData.lockedNicknames = Array.from(currentSession.lockSystem.lockedNicknames.entries());
                sessionData.lockedPhotoData = currentSession.lockSystem.lockedPhotoData;
                sessionData.nameMonitorTime = currentSession.lockSystem.nameMonitorTime;
                sessionData.nicknameMonitorTime = currentSession.lockSystem.nicknameMonitorTime;
                sessionData.photoMonitorTime = currentSession.lockSystem.photoMonitorTime;
            }
        }
        
        sessionData.lastUsed = Date.now();
        sessionData.lastRefresh = Date.now();
        
        const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        permanentSessions.set(sessionId, sessionData);
        
        setupPermanent24_7Session(sessionId, api, userId, groupUID, type);
        
    } catch (error) {
        // NO CONSOLE LOGGING
    }
}

// ==================== ENHANCED SAFE PERMANENT LOCK SYSTEM ====================
class EnhancedSafePermanentLockSystem {
    constructor(sessionId, api, groupUID, userId) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupUID = groupUID;
        this.userId = userId;
        
        // Lock data
        this.lockedName = null;
        this.lockedNicknames = new Map();
        this.lockedPhoto = null;
        this.lockedPhotoData = null;
        this.lockedGroupMembers = new Set();
        
        // User-defined monitoring times (default 60 seconds)
        this.nameMonitorTime = 60000;
        this.nicknameMonitorTime = 60000;
        this.groupMemberMonitorTime = 60000;
        this.photoMonitorTime = 60000;
        
        // Monitoring intervals
        this.nameMonitor = null;
        this.nicknameMonitor = null;
        this.groupMemberMonitor = null;
        this.photoMonitor = null;
        
        // Flags
        this.startMessageSent = false;
        this.is24_7 = true;
        
        // Caches
        this.memberCache = new Map();
        this.lastCheckTime = Date.now();
        this.lastNameCheck = Date.now();
        this.lastNicknameChecks = new Map();
    }

    // ========== GROUP NAME LOCK WITH IMMEDIATE RESTORE ==========
    async lockGroupName(groupName, monitoringTime = 60000) {
        return new Promise((resolve) => {
            try {
                // First set the name
                this.api.setTitle(groupName, this.groupUID, (err) => {
                    if (err) {
                        resolve({ success: false, message: 'Failed to lock group name' });
                    } else {
                        this.lockedName = groupName;
                        this.nameMonitorTime = monitoringTime;
                        this.startNameMonitoring();
                        
                        if (!this.startMessageSent) {
                            this.sendStartLockMessage();
                            this.startMessageSent = true;
                        }
                        
                        resolve({ 
                            success: true, 
                            message: `Group name locked to "${groupName}" with ${monitoringTime/1000}s monitoring` 
                        });
                    }
                });
            } catch (error) {
                resolve({ success: false, message: 'Failed to lock group name' });
            }
        });
    }

    startNameMonitoring() {
        if (this.nameMonitor) {
            clearInterval(this.nameMonitor);
        }
        
        // Fast monitoring (5 seconds)
        this.nameMonitor = setInterval(() => {
            this.checkAndRestoreName();
        }, 5000);
        
        // Immediate first check
        setTimeout(() => this.checkAndRestoreName(), 1000);
    }

    async checkAndRestoreName() {
        if (!this.lockedName) return;
        
        try {
            const now = Date.now();
            // Only check every 5 seconds
            if (now - this.lastNameCheck < 5000) return;
            this.lastNameCheck = now;
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) return;
                
                const currentName = info.threadName || '';
                if (currentName !== this.lockedName) {
                    // Immediate restore
                    this.api.setTitle(this.lockedName, this.groupUID, (setErr) => {
                        if (!setErr) {
                            // Name restored successfully
                        }
                    });
                }
            });
        } catch (error) {
            // Silent error
        }
    }

    // ========== SMART NICKNAME LOCK SYSTEM ==========
    async lockAllNicknames(nickname, monitoringTime = 60000) {
        return new Promise((resolve) => {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    resolve({ success: false, message: 'Failed to get group info' });
                    return;
                }

                const participantIDs = info.participantIDs || [];
                this.nicknameMonitorTime = monitoringTime;
                
                let successCount = 0;
                let processed = 0;

                // Process with 3 second delay between each member
                const processMember = (index) => {
                    if (index >= participantIDs.length) {
                        this.startNicknameMonitoring();
                        this.startGroupMemberMonitoring();
                        resolve({
                            success: successCount > 0,
                            message: `Nicknames locked for ${successCount}/${participantIDs.length} members`,
                            count: successCount,
                            total: participantIDs.length
                        });
                        return;
                    }

                    const userID = participantIDs[index];
                    this.lockedGroupMembers.add(userID);
                    
                    // Check current nickname first
                    this.api.getThreadInfo(this.groupUID, (err, threadInfo) => {
                        if (err || !threadInfo || !threadInfo.userInfo) {
                            // If can't get info, just set it
                            this.api.changeNickname(nickname, this.groupUID, userID, (changeErr) => {
                                processed++;
                                if (!changeErr) {
                                    successCount++;
                                    this.lockedNicknames.set(userID, nickname);
                                    this.memberCache.set(userID, {
                                        id: userID,
                                        nickname: nickname,
                                        lastChecked: Date.now(),
                                        isLocked: true
                                    });
                                }
                                
                                // Next member after 3 seconds
                                setTimeout(() => processMember(index + 1), 3000);
                            });
                            return;
                        }

                        const userInfo = threadInfo.userInfo[userID];
                        const currentNickname = userInfo ? userInfo.nickname : null;
                        
                        // Only change if different
                        if (currentNickname !== nickname) {
                            this.api.changeNickname(nickname, this.groupUID, userID, (changeErr) => {
                                processed++;
                                if (!changeErr) {
                                    successCount++;
                                    this.lockedNicknames.set(userID, nickname);
                                    this.memberCache.set(userID, {
                                        id: userID,
                                        nickname: nickname,
                                        lastChecked: Date.now(),
                                        isLocked: true,
                                        previousNickname: currentNickname
                                    });
                                }
                                
                                // Next member after 3 seconds
                                setTimeout(() => processMember(index + 1), 3000);
                            });
                        } else {
                            processed++;
                            // Already has the right nickname
                            successCount++;
                            this.lockedNicknames.set(userID, nickname);
                            this.memberCache.set(userID, {
                                id: userID,
                                nickname: nickname,
                                lastChecked: Date.now(),
                                isLocked: true,
                                previousNickname: currentNickname
                            });
                            
                            // Next member after 3 seconds
                            setTimeout(() => processMember(index + 1), 3000);
                        }
                    });
                };

                // Start processing
                processMember(0);
            });
        });
    }

    async lockSingleNickname(userID, nickname, monitoringTime = 60000, checkOnlyOnChange = true) {
        return new Promise((resolve) => {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    resolve({ success: false, message: 'Failed to get group info' });
                    return;
                }

                if (!info.participantIDs || !info.participantIDs.includes(userID)) {
                    resolve({ success: false, message: 'User not in group' });
                    return;
                }

                // Get current nickname first
                if (info.userInfo && info.userInfo[userID]) {
                    const currentNickname = info.userInfo[userID].nickname;
                    
                    // Only change if different
                    if (currentNickname === nickname) {
                        this.lockedNicknames.set(userID, nickname);
                        this.memberCache.set(userID, {
                            id: userID,
                            nickname: nickname,
                            lastChecked: Date.now(),
                            isLocked: true,
                            checkOnlyOnChange: checkOnlyOnChange,
                            previousNickname: currentNickname
                        });
                        
                        this.nicknameMonitorTime = monitoringTime;
                        this.startNicknameMonitoring();
                        
                        resolve({
                            success: true,
                            message: `User already has nickname "${nickname}"`
                        });
                        return;
                    }
                }

                this.api.changeNickname(nickname, this.groupUID, userID, (changeErr) => {
                    if (changeErr) {
                        resolve({ success: false, message: changeErr.message });
                    } else {
                        this.lockedNicknames.set(userID, nickname);
                        this.memberCache.set(userID, {
                            id: userID,
                            nickname: nickname,
                            lastChecked: Date.now(),
                            isLocked: true,
                            checkOnlyOnChange: checkOnlyOnChange,
                            previousNickname: null
                        });
                        
                        this.nicknameMonitorTime = monitoringTime;
                        this.startNicknameMonitoring();
                        
                        resolve({
                            success: true,
                            message: `Nickname "${nickname}" locked for user ${userID}`
                        });
                    }
                });
            });
        });
    }

    startNicknameMonitoring() {
        if (this.nicknameMonitor) {
            clearInterval(this.nicknameMonitor);
        }
        
        // Fast monitoring (5 seconds)
        this.nicknameMonitor = setInterval(() => {
            this.checkAndRestoreNicknames();
        }, 5000);
        
        // Immediate first check
        setTimeout(() => this.checkAndRestoreNicknames(), 1000);
    }

    async checkAndRestoreNicknames() {
        if (this.lockedNicknames.size === 0) return;
        
        try {
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info || !info.participantIDs) return;
                
                const currentMembers = new Set(info.participantIDs);
                const now = Date.now();
                
                // Get current nicknames
                const userInfos = info.userInfo || {};
                
                this.lockedNicknames.forEach((lockedNickname, userID) => {
                    if (!currentMembers.has(userID)) {
                        this.lockedNicknames.delete(userID);
                        this.lockedGroupMembers.delete(userID);
                        this.memberCache.delete(userID);
                        return;
                    }
                    
                    const cached = this.memberCache.get(userID);
                    if (cached && cached.checkOnlyOnChange) {
                        return;
                    }
                    
                    const currentNickname = userInfos[userID] ? userInfos[userID].nickname : null;
                    
                    // Only restore if nickname is different
                    if (currentNickname !== lockedNickname) {
                        this.api.changeNickname(lockedNickname, this.groupUID, userID, (changeErr) => {
                            if (!changeErr) {
                                if (cached) {
                                    cached.lastChecked = now;
                                    cached.previousNickname = currentNickname;
                                }
                            }
                        });
                    } else if (cached) {
                        cached.lastChecked = now;
                    }
                });
            });
        } catch (error) {
            // Silent error
        }
    }

    // ========== GROUP MEMBER LOCK ==========
    startGroupMemberMonitoring() {
        if (this.groupMemberMonitor) {
            clearInterval(this.groupMemberMonitor);
        }
        
        this.groupMemberMonitor = setInterval(() => {
            this.checkAndAddMembers();
        }, this.groupMemberMonitorTime);
    }

    checkAndAddMembers() {
        if (this.lockedGroupMembers.size === 0) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info || !info.participantIDs) return;
            
            const currentMembers = new Set(info.participantIDs);
            const lockedNickname = this.getLockedNicknameForAll();
            
            currentMembers.forEach(userID => {
                if (!this.lockedGroupMembers.has(userID)) {
                    setTimeout(() => {
                        if (lockedNickname) {
                            this.api.changeNickname(lockedNickname, this.groupUID, userID, () => {
                                this.lockedGroupMembers.add(userID);
                                this.lockedNicknames.set(userID, lockedNickname);
                                this.memberCache.set(userID, {
                                    id: userID,
                                    nickname: lockedNickname,
                                    lastChecked: Date.now(),
                                    isLocked: true
                                });
                            });
                        }
                    }, 10000);
                }
            });
            
            this.lockedGroupMembers.forEach(userID => {
                if (!currentMembers.has(userID)) {
                    this.lockedGroupMembers.delete(userID);
                    this.lockedNicknames.delete(userID);
                    this.memberCache.delete(userID);
                }
            });
        });
    }

    getLockedNicknameForAll() {
        if (this.lockedNicknames.size === 0) return null;
        
        const firstEntry = this.lockedNicknames.entries().next().value;
        return firstEntry ? firstEntry[1] : null;
    }

    // ========== GROUP PHOTO LOCK SYSTEM ==========
    async lockGroupPhoto(photoPath, monitoringTime = 60000) {
        return new Promise((resolve) => {
            try {
                const photoData = fs.readFileSync(photoPath);
                this.lockedPhoto = photoPath;
                this.lockedPhotoData = photoData.toString('base64');
                this.photoMonitorTime = monitoringTime;
                
                this.api.changeGroupImage(photoData, this.groupUID, (err) => {
                    if (err) {
                        resolve({ success: false, message: err.message });
                    } else {
                        this.startPhotoMonitoring();
                        resolve({
                            success: true,
                            message: `Group photo locked with ${monitoringTime/1000}s monitoring`
                        });
                    }
                });
            } catch (error) {
                resolve({ success: false, message: error.message });
            }
        });
    }

    startPhotoMonitoring() {
        if (this.photoMonitor) {
            clearInterval(this.photoMonitor);
        }
        
        this.photoMonitor = setInterval(() => {
            this.checkAndRestorePhoto();
        }, this.photoMonitorTime);
        
        setTimeout(() => this.checkAndRestorePhoto(), 5000);
    }

    checkAndRestorePhoto() {
        if (!this.lockedPhotoData) return;
        
        try {
            const photoData = Buffer.from(this.lockedPhotoData, 'base64');
            this.api.changeGroupImage(photoData, this.groupUID, (err) => {
                if (!err) {
                    // Photo restored
                }
            });
        } catch (error) {
            // Silent error
        }
    }

    // ========== PHOTO SEND FEATURE ==========
    async sendPhotoToGroup(photoPath, caption = '') {
        return new Promise((resolve) => {
            try {
                const photoData = fs.readFileSync(photoPath);
                const messageData = {
                    body: caption,
                    attachment: photoData
                };
                
                this.api.sendMessage(messageData, this.groupUID, (err, msgInfo) => {
                    if (err) {
                        resolve({ success: false, message: err.message });
                    } else {
                        resolve({
                            success: true,
                            message: 'Photo sent successfully'
                        });
                    }
                });
            } catch (error) {
                resolve({ success: false, message: error.message });
            }
        });
    }

    // ========== START LOCK MESSAGE ==========
    sendStartLockMessage() {
        const message = "TUMHARA BAAP RAJ MISHRA NE GC LOCK KAR DIYA AB MA CHUDWAO BYE  🙂💔";
        const boldMessage = `**${message}**`;
        
        this.api.sendMessage(boldMessage, this.groupUID, (err) => {
            if (!err) {
                // Message sent successfully
            }
        });
    }

    // ========== STOP ALL MONITORING ==========
    stopAllMonitoring() {
        if (this.nameMonitor) clearInterval(this.nameMonitor);
        if (this.nicknameMonitor) clearInterval(this.nicknameMonitor);
        if (this.groupMemberMonitor) clearInterval(this.groupMemberMonitor);
        if (this.photoMonitor) clearInterval(this.photoMonitor);
        
        this.nameMonitor = null;
        this.nicknameMonitor = null;
        this.groupMemberMonitor = null;
        this.photoMonitor = null;
    }

    // ========== GET STATUS ==========
    getStatus() {
        return {
            sessionId: this.sessionId,
            groupUID: this.groupUID,
            userId: this.userId,
            lockedName: this.lockedName,
            lockedNicknames: Array.from(this.lockedNicknames.entries()).map(([id, nick]) => ({ id, nick })),
            lockedGroupMembers: this.lockedGroupMembers.size,
            lockedPhoto: !!this.lockedPhoto,
            nameMonitorTime: this.nameMonitorTime,
            nicknameMonitorTime: this.nicknameMonitorTime,
            groupMemberMonitorTime: this.groupMemberMonitorTime,
            photoMonitorTime: this.photoMonitorTime,
            startMessageSent: this.startMessageSent,
            is24_7: this.is24_7,
            memberCacheSize: this.memberCache.size
        };
    }
}

// ==================== ADVANCED BOT SYSTEM WITH ALL FEATURES ====================
class AdvancedBotSystem {
    constructor(sessionId, api, groupUID, adminUID, prefix) {
        this.sessionId = sessionId;
        this.api = api;
        this.groupUID = groupUID;
        this.adminUID = adminUID;
        this.prefix = prefix || '/';
        
        this.isRunning = false;
        this.botStartTime = Date.now();
        this.messageQueue = [];
        this.fytTargetUser = null;
        this.fytInterval = 10000;
        this.fytMessageIndex = 0;
        this.fytMessages = [];
        this.fytModeActive = false;
        this.fytTimer = null;
        
        this.autoReplyTarget = null;
        this.autoReplyMode = false;
        this.autoReplyMessages = [];
        this.autoReplyIndex = 0;
        
        this.mastiBotActive = false;
        this.mastiBotTimer = null;
        
        this.sexChatMode = false;
        this.sexChatPartner = null;
        
        this.groupNameLock = false;
        this.nicknameLock = false;
        this.groupName = '';
        this.nickname = '';
        
        this.lastMembers = new Set();
        this.lastActivity = Date.now();
        
        this.welcomeMessages = [
            "🎉 **Welcome {name}!** Aapka swagat hai!",
            "👋 **Assalamualaikum {name}!** Khush amdeed!",
            "😊 **Hey {name}!** Aapke aane se group khush hua!",
            "🌟 **{name} ji** aapka intezaar tha! Welcome!",
            "💫 **Aao {name}!** Group ki shaan badhao!"
        ];
        
        this.funnyResponses = [
            "Haha, aap bhi na! 😂",
            "Mast joke maara! 🤣",
            "Aapki baatein sunke maza aa jata hai! 😊",
            "Kya baat hai! 👏",
            "Waah! Kya baat kahi! 😎",
            "Haha, bilkul sahi! 😄",
            "Aap to comedian nikle! 🎭",
            "Too funny! 😆",
            "Ruk jaao, hassi se pet dard ho raha hai! 🤣",
            "Aapki humor sense zabardast hai! 👍"
        ];
        
        this.sadShayris = [
            "Dard ka ehsaas hai, gum ki tareekh hai,\n{name} ki aankhon mein aansuon ki lakeer hai... 💔",
            "Tanhai ki raat hai, dard ka safar hai,\n{name} ki yaadon ka zamana hai bekarar... 😔",
            "Khamoshi hai bas, shor nahi,\n{name} ke dil mein dard ka zor nahi... 🌧️",
            "Aansu beh rahe hain, dil ro raha hai,\n{name} ki yaadon ka sama hai tanhai... 😢",
            "Zindagi ka safar hai, dard ka pahar hai,\n{name} ki muskurahat ab bas tasveer hai... 🕯️"
        ];
        
        this.loveShayris = [
            "Dil ki dhadkan hai, mohabbat ka ehsaas hai,\n{name} se pyaar hai, yeh meri pehchan hai... ❤️",
            "Aankhon mein chamak hai, dil mein pyaar hai,\n{name} ki yaadon ka mera silsila hai... 💖",
            "Pyaar ki baat hai, dil ki raftaar hai,\n{name} se mohabbat hai, yeh meri pehchaar hai... 🌹",
            "Dil diya hai, jaan bhi denge,\n{name} ke liye duniya se lad bhi lenge... 💘",
            "Pyaar hai tumse, bas yahi kehna hai,\n{name} ki baahon mein jeena aur marna hai... 💕"
        ];
        
        this.hateShayris = [
            "Nafrat ka samundar hai, dushmani ki lehrain hain,\n{name} se door rehna meri duayein hain... 👿",
            "Dil mein gussa hai, aankhon mein aag hai,\n{name} ki yaadon se ab taklaag hai... 💢",
            "Nafrat ka jazba hai, gusse ki aag hai,\n{name} se doori meri pehchan hai... 🚫",
            "Dushmani ka safar hai, nafrat ka pahar hai,\n{name} ki yaadon se ab takrar hai... ⚡",
            "Gusse ki lehrain hain, nafrat ki baatein hain,\n{name} se doori meri khwahish hain... 🔥"
        ];
        
        this.pyaarShayris = [
            "Tumhari aankhon mein maine apni duniya dekhi,\n{name} tum ho to lagta hai sab kuch hai... 💑",
            "Dil ki dhadkan tum ho, saansein tum ho,\n{name} tumhari baahon mein hi mera ghar hai... 💒",
            "Tumse mohabbat hai, yeh haqeeqat hai,\n{name} tumhari har ada meri khwahish hai... 💓",
            "Pyaar ka ehsaas tum ho, khushi ka raaz tum ho,\n{name} tumhare bina adhoora hai har lamha... 💞",
            "Tum ho to zindagi hai, tum ho to khushi hai,\n{name} tumhari har saans meri duaa hai... 💗"
        ];
        
        this.sexChatResponses = {
            'chut': "Dheere dheere meri palango utaro uske baad uske andar ki gili bikini utaro samne tumko mast gori chut milegi 😊",
            'ungli': "Phle meri chut me ungli karo aur mujhe mza do jab tak mein jhad na jau aur mein v tumhara lund hilaungi tab tak 😋",
            'lund': "Mein tumhara pant kholke chaddi se lund nikalke chusungi 🤤🤤",
            'gand': "Mujhe ab ulta ghumao aur meri gand me apna lund ragro aah mza aa raha h 😘",
            'gandchudai': "Aah baby meri gand ko chodo apne lund se meri gand tight h ise faad do 😊",
            'chutchudai': "Madarchod ab mujhe godi me uthao aur meri chut me apna lund ghusake meri pyaad bujhao aur feel karo 🔥",
            'boobs': "Meri tshirt utaro mere chuchi bahut bde h use dabao aur dudh pio mein garam houngi usse phir chudai me mza aayega 🍼",
            'ghodisex': "Mujhe ghodi bnake chodo meri gand meri chut faar do 🐎",
            'sexend': "Madarchod itna hi dam tha meri chut me hi maal chhod do mujhe apni randi bna do aur jab chahe chodna mein roj mza dungi 😊❤ tumhari randi usha"
        };
        
        this.commandsList = {
            'Basic': [
                '/on - Start bot',
                '/off - Stop bot',
                '/status - Bot status',
                '/help - Show all commands',
                '/groupuid - Show group ID'
            ],
            'FYT Mode (Admin Only)': [
                '/fyt mode on [user id] [seconds] - Start FYT mode',
                '/fyt mode off - Stop FYT mode'
            ],
            'Auto Reply (Admin Only)': [
                '/autoreplyon [user id] - Start auto reply',
                '/autoreplyoff - Stop auto reply'
            ],
            'Lock Commands (Admin Only)': [
                '/groupnamelockon [name] - Lock group name',
                '/groupnamelockoff - Unlock group name',
                '/nicknamelockon [nickname] - Lock all nicknames',
                '/nicknamelockoff - Unlock nicknames'
            ],
            'Masti Mode (All)': [
                '/mastiboton - Start masti bot',
                '/mastibotoff - Stop masti bot',
                '/pyaar - Love shayri',
                '/sad - Sad shayri',
                '/pair - Pair members',
                '/love - Love purpose',
                '/hate - Hate shayri',
                '/raj - About Raj Mishra'
            ],
            'Sex Chat Mode (All)': [
                '/sexchaton - Start sex chat',
                '/sexchatoff - Stop sex chat',
                '/chut - Sex talk',
                '/ungli - Sex talk',
                '/lund - Sex talk',
                '/gand - Sex talk',
                '/gandchudai - Sex talk',
                '/chutchudai - Sex talk',
                '/boobs - Sex talk',
                '/ghodisex - Sex talk',
                '/sexend - End sex chat'
            ],
            'Media Commands (All)': [
                '/mp3song [song name] - Send MP3 song',
                '/mp4video [video name] - Send MP4 video',
                '/boysdp20 - Send 20 boys DP',
                '/girlsdp20 - Send 20 girls DP'
            ]
        };
        
        // Setup message listener
        this.setupMessageListener();
    }
    
    setupMessageListener() {
        this.api.listen((err, message) => {
            if (err || !message || message.type !== 'message') return;
            
            if (message.threadID === this.groupUID) {
                this.handleMessage(message);
            }
            
            // Handle auto reply
            if (this.autoReplyMode && this.autoReplyTarget && 
                message.threadID === this.groupUID && 
                message.senderID === this.autoReplyTarget) {
                this.handleAutoReply(message);
            }
            
            // Handle sex chat reply
            if (this.sexChatMode && this.sexChatPartner && 
                message.threadID === this.groupUID && 
                message.senderID === this.sexChatPartner) {
                this.handleSexChatReply(message);
            }
            
            // Handle masti bot reply
            if (this.mastiBotActive && 
                message.threadID === this.groupUID && 
                message.senderID !== this.adminUID) {
                this.handleMastiBotReply(message);
            }
        });
    }
    
    handleMessage(message) {
        const body = message.body || '';
        const senderID = message.senderID;
        
        // Check if message starts with prefix
        if (!body.startsWith(this.prefix)) return;
        
        const command = body.slice(this.prefix.length).trim().toLowerCase();
        
        // Check for admin commands
        const isAdmin = senderID === this.adminUID;
        
        // Handle commands based on mode
        if (command === 'on') {
            if (isAdmin) {
                this.start();
                this.api.sendMessage(
                    `**🤖 BOT HAZIR H APKI SEWA ME DEVELOPED BY R4J M1SHR4 OWNER RAJ MISHRA**`,
                    this.groupUID
                );
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'off') {
            if (isAdmin) {
                this.stop();
                this.api.sendMessage(
                    `**🤖 Bot is shutting down...**`,
                    this.groupUID
                );
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'status') {
            this.showStatus();
        }
        else if (command === 'help') {
            this.showHelp();
        }
        else if (command === 'groupuid') {
            this.api.sendMessage(
                `**Group UID:** ${this.groupUID}`,
                this.groupUID
            );
        }
        else if (command.startsWith('fyt mode on ')) {
            if (isAdmin) {
                this.handleFytModeOn(command);
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'fyt mode off') {
            if (isAdmin) {
                this.stopFytMode();
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command.startsWith('autoreplyon')) {
            if (isAdmin) {
                this.handleAutoReplyOn(command);
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'autoreplyoff') {
            if (isAdmin) {
                this.stopAutoReply();
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'mastiboton') {
            this.startMastiBot();
        }
        else if (command === 'mastibotoff') {
            if (isAdmin) {
                this.stopMastiBot();
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'sexchaton') {
            this.startSexChat(senderID);
        }
        else if (command === 'sexchatoff') {
            this.stopSexChat();
        }
        else if (this.sexChatResponses[command]) {
            if (this.sexChatMode) {
                this.api.sendMessage(
                    `**${this.sexChatResponses[command]}**`,
                    this.groupUID
                );
            }
        }
        else if (command === 'pyaar') {
            this.sendPyaarShayri(senderID);
        }
        else if (command === 'sad') {
            this.sendSadShayri(senderID);
        }
        else if (command === 'pair') {
            this.createPair(senderID);
        }
        else if (command === 'love') {
            this.sendLovePurpose(senderID);
        }
        else if (command === 'hate') {
            this.sendHateShayri(senderID);
        }
        else if (command === 'raj') {
            this.sendRajMessage(senderID);
        }
        else if (command.startsWith('mp3song ')) {
            const songName = command.substring('mp3song '.length);
            this.sendSong(songName);
        }
        else if (command.startsWith('mp4video ')) {
            const videoName = command.substring('mp4video '.length);
            this.sendVideo(videoName);
        }
        else if (command === 'boysdp20') {
            this.sendBoysDP(20);
        }
        else if (command === 'girlsdp20') {
            this.sendGirlsDP(20);
        }
        else if (command.startsWith('groupnamelockon ')) {
            if (isAdmin) {
                const name = command.substring('groupnamelockon '.length);
                this.lockGroupName(name);
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'groupnamelockoff') {
            if (isAdmin) {
                this.unlockGroupName();
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command.startsWith('nicknamelockon ')) {
            if (isAdmin) {
                const nickname = command.substring('nicknamelockon '.length);
                this.lockAllNicknames(nickname);
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        else if (command === 'nicknamelockoff') {
            if (isAdmin) {
                this.unlockAllNicknames();
            } else {
                this.sendAdminOnlyMessage();
            }
        }
        
        // Check for member changes
        this.checkMemberChanges();
    }
    
    sendAdminOnlyMessage() {
        this.api.sendMessage(
            `**PLEASE MERE OWNER RAJ MISHRA SE BAAT KARO JAKE 😊😊!**`,
            this.groupUID
        );
    }
    
    async handleFytModeOn(command) {
        const parts = command.split(' ');
        if (parts.length < 5) {
            this.api.sendMessage(
                `**Format:** ${this.prefix}fyt mode on [userID] [intervalSeconds]`,
                this.groupUID
            );
            return;
        }
        
        const targetID = parts[3];
        const interval = parseInt(parts[4]) * 1000;
        
        if (isNaN(interval) || interval < 1000) {
            this.api.sendMessage('**Invalid interval! Minimum 1 second**', this.groupUID);
            return;
        }
        
        this.fytTargetUser = targetID;
        this.fytInterval = interval;
        
        this.api.sendMessage(
            `**FYT mode on Batao raj kiski bahan chodni hai 😎**`,
            this.groupUID
        );
        
        // Load messages if not loaded
        if (this.fytMessages.length === 0) {
            // In real implementation, load from file
            this.fytMessages = [
                "Kya haal hai sexy? 😉",
                "Aaj toh look badi killer hai! 😎",
                "Koi date pe chaloge? 🤭",
                "Mujhe toh aap pasand aa gaye! 😘",
                "Aapki smile ne dil jeet liya! 😊",
                "Kya aap single ho? Asking for a friend 😜",
                "Aapke sath time spend karna achha lagta hai! 💖"
            ];
        }
        
        this.startFytMode();
    }
    
    startFytMode() {
        if (this.fytModeActive) return;
        
        this.fytModeActive = true;
        this.fytMessageIndex = 0;
        
        this.fytTimer = setInterval(() => {
            if (!this.fytModeActive || !this.fytTargetUser) return;
            
            const message = this.fytMessages[this.fytMessageIndex % this.fytMessages.length];
            const mention = `@[${this.fytTargetUser}:${this.fytTargetUser}]`;
            
            this.api.sendMessage(`${mention} ${message}`, this.groupUID);
            this.fytMessageIndex++;
            
        }, this.fytInterval);
    }
    
    stopFytMode() {
        this.fytModeActive = false;
        if (this.fytTimer) {
            clearInterval(this.fytTimer);
            this.fytTimer = null;
        }
        this.api.sendMessage('**FYT mode off**', this.groupUID);
    }
    
    async handleAutoReplyOn(command) {
        const parts = command.split(' ');
        let targetID = null;
        
        if (parts.length > 1) {
            targetID = parts[1];
        }
        
        this.autoReplyTarget = targetID;
        this.autoReplyMode = true;
        
        this.api.sendMessage(
            `**Auto reply on Batao Raj kis madarchod ki bahan ki chut maarni hai 😎!**`,
            this.groupUID
        );
        
        // Load auto reply messages
        this.autoReplyMessages = [
            "Haan bhai, kya baat hai? 😊",
            "Sun raha hu, bolo! 👂",
            "Kya keh rahe ho? 🤔",
            "Achha! 😄",
            "Haha, sahi baat hai! 😂",
            "Chalo, aage bolo! 🎤",
            "Mast baat ki! 👍",
            "Waah! Kya baat hai! 👏",
            "Hmm, samajh gaya! 🤓",
            "Theek hai, chal raha hu! 🏃"
        ];
        
        this.autoReplyIndex = 0;
    }
    
    handleAutoReply(message) {
        if (!this.autoReplyMode || !this.autoReplyTarget) return;
        
        const replyMessage = this.autoReplyMessages[this.autoReplyIndex % this.autoReplyMessages.length];
        const mention = `@[${message.senderID}:${message.senderID}]`;
        
        this.api.sendMessage(`${mention} ${replyMessage}`, this.groupUID);
        this.autoReplyIndex++;
    }
    
    stopAutoReply() {
        this.autoReplyMode = false;
        this.autoReplyTarget = null;
        this.api.sendMessage('**Auto reply off**', this.groupUID);
    }
    
    startMastiBot() {
        if (this.mastiBotActive) return;
        
        this.mastiBotActive = true;
        this.api.sendMessage(
            `**Bolo Bhai mein raj mishra ka bot hu masti mood me hu apko kya masti karni hai 😁😁!**`,
            this.groupUID
        );
    }
    
    async handleMastiBotReply(message) {
        if (!this.mastiBotActive) return;
        
        const body = message.body || '';
        const senderID = message.senderID;
        
        // Don't reply to commands
        if (body.startsWith(this.prefix)) return;
        
        // Get user info
        try {
            const userInfo = await new Promise((resolve) => {
                this.api.getUserInfo(senderID, (err, info) => {
                    resolve(info ? info[senderID] : null);
                });
            });
            
            const userName = userInfo ? userInfo.name : 'User';
            
            // Check for specific keywords
            if (body.toLowerCase().includes('bot') || body.toLowerCase().includes('hello') || 
                body.toLowerCase().includes('hi') || body.toLowerCase().includes('hey')) {
                
                const responses = [
                    `Haha, haan bhai ${userName}! Main bot hu lekin masti karne ke liye tayaar! 😄`,
                    `Kya haal hai ${userName}? Mazaa aa raha hai na? 😎`,
                    `Aur ${userName}, kya chal raha hai? Masti karenge! 🤪`,
                    `Haan bhai ${userName}, bol kya karu? 😊`,
                    `${userName} bhai, aaj ka plan kya hai? 😜`
                ];
                
                const randomResponse = responses[Math.floor(Math.random() * responses.length)];
                this.api.sendMessage(randomResponse, this.groupUID);
                
            } else {
                // Generic funny response
                const randomResponse = this.funnyResponses[Math.floor(Math.random() * this.funnyResponses.length)];
                this.api.sendMessage(`${userName}, ${randomResponse}`, this.groupUID);
            }
            
        } catch (error) {
            // Silent error
        }
    }
    
    stopMastiBot() {
        this.mastiBotActive = false;
        this.api.sendMessage('**Masti bot off**', this.groupUID);
    }
    
    startSexChat(partnerID) {
        this.sexChatMode = true;
        this.sexChatPartner = partnerID;
        
        this.api.sendMessage(
            `**Hi i m usha meri chut gori aur chikni h kya ap log mujhe chodna chahoge 😊**`,
            this.groupUID
        );
    }
    
    handleSexChatReply(message) {
        if (!this.sexChatMode || !this.sexChatPartner) return;
        
        const body = message.body || '';
        
        // Simple response based on keywords
        if (body.toLowerCase().includes('chod') || body.toLowerCase().includes('sex') || 
            body.toLowerCase().includes('fuck') || body.toLowerCase().includes('chut')) {
            
            const responses = [
                "Aah baby, mujhe chodo zor se! 😘",
                "Meri chut tight hai, dheere se andar ghusao! 💦",
                "Aah haan, yehi chahiye tha mujhe! 🔥",
                "Meri chut gili ho gayi hai, ab chodo! 😋",
                "Zor se thokna, mujhe maza aa raha hai! 🍆"
            ];
            
            const randomResponse = responses[Math.floor(Math.random() * responses.length)];
            this.api.sendMessage(`**${randomResponse}**`, this.groupUID);
        }
    }
    
    stopSexChat() {
        this.sexChatMode = false;
        this.sexChatPartner = null;
        this.api.sendMessage('**Sex chat off**', this.groupUID);
    }
    
    sendPyaarShayri(userID) {
        this.api.getUserInfo(userID, (err, info) => {
            if (err || !info || !info[userID]) return;
            
            const userName = info[userID].name;
            const shayri = this.pyaarShayris[Math.floor(Math.random() * this.pyaarShayris.length)]
                .replace(/{name}/g, userName);
            
            this.api.sendMessage(`**${shayri}**`, this.groupUID);
        });
    }
    
    sendSadShayri(userID) {
        this.api.getUserInfo(userID, (err, info) => {
            if (err || !info || !info[userID]) return;
            
            const userName = info[userID].name;
            const shayri = this.sadShayris[Math.floor(Math.random() * this.sadShayris.length)]
                .replace(/{name}/g, userName);
            
            this.api.sendMessage(`**${shayri}**`, this.groupUID);
        });
    }
    
    sendLovePurpose(userID) {
        this.api.getUserInfo(userID, (err, info) => {
            if (err || !info || !info[userID]) return;
            
            const userName = info[userID].name;
            const shayri = this.loveShayris[Math.floor(Math.random() * this.loveShayris.length)]
                .replace(/{name}/g, userName);
            
            this.api.sendMessage(`**${shayri}**`, this.groupUID);
        });
    }
    
    sendHateShayri(userID) {
        this.api.getUserInfo(userID, (err, info) => {
            if (err || !info || !info[userID]) return;
            
            const userName = info[userID].name;
            const shayri = this.hateShayris[Math.floor(Math.random() * this.hateShayris.length)]
                .replace(/{name}/g, userName);
            
            this.api.sendMessage(`**${shayri}**`, this.groupUID);
        });
    }
    
    async createPair(userID) {
        try {
            const info = await new Promise((resolve) => {
                this.api.getThreadInfo(this.groupUID, (err, info) => {
                    resolve(info);
                });
            });
            
            if (!info || !info.participantIDs || info.participantIDs.length < 2) return;
            
            // Get random member (not the command sender)
            const otherMembers = info.participantIDs.filter(id => id !== userID);
            if (otherMembers.length === 0) return;
            
            const randomMemberID = otherMembers[Math.floor(Math.random() * otherMembers.length)];
            
            // Get names
            const userInfo = await new Promise((resolve) => {
                this.api.getUserInfo([userID, randomMemberID], (err, info) => {
                    resolve(info);
                });
            });
            
            const userName = userInfo && userInfo[userID] ? userInfo[userID].name : 'User1';
            const pairName = userInfo && userInfo[randomMemberID] ? userInfo[randomMemberID].name : 'User2';
            
            const pairMessages = [
                `**${userName} ❤️ ${pairName}** - Love birds! 💑`,
                `**${userName} + ${pairName}** = Perfect match! 💘`,
                `**${userName} & ${pairName}** - Made for each other! 💕`,
                `**${userName} 🤝 ${pairName}** - Best couple! 💑`,
                `**${userName} 💞 ${pairName}** - Jodi no. 1! 🏆`
            ];
            
            const randomMessage = pairMessages[Math.floor(Math.random() * pairMessages.length)];
            this.api.sendMessage(randomMessage, this.groupUID);
            
        } catch (error) {
            // Silent error
        }
    }
    
    sendRajMessage(userID) {
        if (userID === this.adminUID) {
            this.api.sendMessage(
                `**Owner sir, aap hi to mere creator ho! 😊❤**`,
                this.groupUID
            );
            return;
        }
        
        this.api.getUserInfo(userID, (err, info) => {
            if (err || !info || !info[userID]) return;
            
            const userName = info[userID].name;
            const firstName = userName.split(' ')[0];
            
            // Check if name sounds female
            const femaleNames = ['priya', 'sonia', 'riya', 'neha', 'anjali', 'pooja', 'kavita', 'sarita', 'radha', 'sita'];
            const isFemale = femaleNames.some(name => userName.toLowerCase().includes(name));
            
            if (isFemale) {
                this.api.sendMessage(
                    `**${firstName} tum mere owner raj mishra se saadi kr lo 😊❤**`,
                    this.groupUID
                );
            } else {
                this.api.sendMessage(
                    `**${firstName} tum mere owner raj mishra ka muth maar do 😊❤**`,
                    this.groupUID
                );
            }
        });
    }
    
    showStatus() {
        const now = Date.now();
        const uptime = now - this.botStartTime;
        
        const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((uptime % (1000 * 60)) / 1000);
        
        const startDate = new Date(this.botStartTime).toLocaleString();
        
        let statusText = `**🤖 BOT STATUS**\n\n`;
        statusText += `**Active Since:** ${startDate}\n`;
        statusText += `**Uptime:** ${days}d ${hours}h ${minutes}m ${seconds}s\n`;
        statusText += `**Status:** ${this.isRunning ? 'RUNNING' : 'STOPPED'}\n`;
        statusText += `**Group:** ${this.groupUID}\n`;
        statusText += `**Admin:** ${this.adminUID}\n`;
        statusText += `**FYT Mode:** ${this.fytModeActive ? 'ON' : 'OFF'}\n`;
        statusText += `**Auto Reply:** ${this.autoReplyMode ? 'ON' : 'OFF'}\n`;
        statusText += `**Masti Bot:** ${this.mastiBotActive ? 'ON' : 'OFF'}\n`;
        statusText += `**Sex Chat:** ${this.sexChatMode ? 'ON' : 'OFF'}\n`;
        
        this.api.sendMessage(statusText, this.groupUID);
    }
    
    showHelp() {
        let helpText = `**🤖 BOT COMMANDS HELP**\n\n`;
        
        for (const [category, commands] of Object.entries(this.commandsList)) {
            helpText += `**${category}:**\n`;
            commands.forEach(cmd => {
                helpText += `${cmd}\n`;
            });
            helpText += `\n`;
        }
        
        this.api.sendMessage(helpText, this.groupUID);
    }
    
    async lockGroupName(name) {
        try {
            this.groupName = name;
            this.groupNameLock = true;
            
            // First set the name
            this.api.setTitle(name, this.groupUID, (err) => {
                if (err) {
                    this.api.sendMessage(`**Failed to lock group name**`, this.groupUID);
                } else {
                    this.api.sendMessage(`**✅ Group name locked to: "${name}"**`, this.groupUID);
                    this.startGroupNameMonitoring();
                }
            });
            
        } catch (error) {
            this.api.sendMessage(`**Failed to lock group name**`, this.groupUID);
        }
    }
    
    startGroupNameMonitoring() {
        if (this.groupNameMonitoring) {
            clearInterval(this.groupNameMonitoring);
        }
        
        // Fast monitoring (5 seconds)
        this.groupNameMonitoring = setInterval(() => {
            if (!this.groupNameLock) return;
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) return;
                
                const currentName = info.threadName || '';
                if (currentName !== this.groupName) {
                    // Immediate restore
                    this.api.setTitle(this.groupName, this.groupUID, () => {
                        // Auto restore
                    });
                }
            });
        }, 5000); // Check every 5 seconds
    }
    
    unlockGroupName() {
        this.groupNameLock = false;
        if (this.groupNameMonitoring) {
            clearInterval(this.groupNameMonitoring);
            this.groupNameMonitoring = null;
        }
        this.api.sendMessage('**Group name lock turned OFF**', this.groupUID);
    }
    
    async lockAllNicknames(nickname) {
        try {
            this.nickname = nickname;
            this.nicknameLock = true;
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info) {
                    this.api.sendMessage('**Failed to get group info**', this.groupUID);
                    return;
                }
                
                const participants = info.participantIDs || [];
                const userInfos = info.userInfo || {};
                let successCount = 0;
                let processed = 0;
                
                const processMember = (index) => {
                    if (index >= participants.length) {
                        this.api.sendMessage(
                            `**✅ Nicknames locked for ${successCount} members**`,
                            this.groupUID
                        );
                        this.startNicknameMonitoring();
                        return;
                    }
                    
                    const userID = participants[index];
                    const currentNickname = userInfos[userID] ? userInfos[userID].nickname : null;
                    
                    // Only change if different
                    if (currentNickname !== nickname) {
                        this.api.changeNickname(nickname, this.groupUID, userID, (changeErr) => {
                            processed++;
                            if (!changeErr) successCount++;
                            
                            // Next member after 3 seconds
                            setTimeout(() => processMember(index + 1), 3000);
                        });
                    } else {
                        processed++;
                        successCount++;
                        // Already has the right nickname
                        setTimeout(() => processMember(index + 1), 3000);
                    }
                };
                
                processMember(0);
            });
            
        } catch (error) {
            this.api.sendMessage('**Failed to lock nicknames**', this.groupUID);
        }
    }
    
    startNicknameMonitoring() {
        if (this.nicknameMonitoring) {
            clearInterval(this.nicknameMonitoring);
        }
        
        // Fast monitoring (5 seconds)
        this.nicknameMonitoring = setInterval(() => {
            if (!this.nicknameLock) return;
            
            this.api.getThreadInfo(this.groupUID, (err, info) => {
                if (err || !info || !info.participantIDs) return;
                
                const currentMembers = new Set(info.participantIDs);
                const userInfos = info.userInfo || {};
                
                currentMembers.forEach(userID => {
                    const currentNickname = userInfos[userID] ? userInfos[userID].nickname : null;
                    
                    // Only restore if different
                    if (currentNickname !== this.nickname) {
                        this.api.changeNickname(this.nickname, this.groupUID, userID, () => {
                            // Auto restore
                        });
                    }
                });
            });
        }, 5000); // Check every 5 seconds
    }
    
    unlockAllNicknames() {
        this.nicknameLock = false;
        if (this.nicknameMonitoring) {
            clearInterval(this.nicknameMonitoring);
            this.nicknameMonitoring = null;
        }
        this.api.sendMessage('**Nickname lock turned OFF**', this.groupUID);
    }
    
    async sendSong(songName) {
        // In real implementation, this would fetch and send MP3
        this.api.sendMessage(
            `**🎵 Song "${songName}" will be sent shortly! (Feature in development)**`,
            this.groupUID
        );
    }
    
    async sendVideo(videoName) {
        // In real implementation, this would fetch and send MP4
        this.api.sendMessage(
            `**🎬 Video "${videoName}" will be sent shortly! (Feature in development)**`,
            this.groupUID
        );
    }
    
    async sendBoysDP(count) {
        for (let i = 1; i <= count; i++) {
            setTimeout(() => {
                this.api.sendMessage(
                    `**👦 Boy's DP ${i} (Indian looking)**`,
                    this.groupUID
                );
            }, i * 2000);
        }
    }
    
    async sendGirlsDP(count) {
        for (let i = 1; i <= count; i++) {
            setTimeout(() => {
                this.api.sendMessage(
                    `**👧 Girl's DP ${i} (Indian looking)**`,
                    this.groupUID
                );
            }, i * 2000);
        }
    }
    
    checkMemberChanges() {
        if (!this.isRunning) return;
        
        this.api.getThreadInfo(this.groupUID, (err, info) => {
            if (err || !info || !info.participantIDs) return;
            
            const currentMembers = new Set(info.participantIDs);
            
            // Check for new members
            currentMembers.forEach(member => {
                if (!this.lastMembers.has(member)) {
                    this.welcomeNewMember(member);
                }
            });
            
            // Check for left members
            this.lastMembers.forEach(member => {
                if (!currentMembers.has(member)) {
                    this.handleLeftMember(member);
                }
            });
            
            this.lastMembers = currentMembers;
        });
    }
    
    async welcomeNewMember(userID) {
        try {
            const userInfo = await new Promise((resolve) => {
                this.api.getUserInfo(userID, (err, info) => {
                    resolve(info ? info[userID] : null);
                });
            });
            
            const name = userInfo ? userInfo.name : 'New Member';
            const welcomeMsg = this.welcomeMessages[Math.floor(Math.random() * this.welcomeMessages.length)]
                .replace('{name}', name);
            
            this.api.sendMessage(`**${welcomeMsg}**`, this.groupUID);
            
        } catch (error) {
            // Silent error
        }
    }
    
    async handleLeftMember(userID) {
        try {
            const userInfo = await new Promise((resolve) => {
                this.api.getUserInfo(userID, (err, info) => {
                    resolve(info ? info[userID] : null);
                });
            });
            
            const name = userInfo ? userInfo.name : 'A Member';
            
            // Send message
            this.api.sendMessage(
                `**⚠️ ${name} kaha bhag rahe ho bina raj mishra ke permission ke 🤣🤣**`,
                this.groupUID
            );
            
            // Try to add back (in real implementation)
            // this.api.addUserToGroup(userID, this.groupUID, (err) => {
            //     if (!err) {
            //         this.api.sendMessage(`**✅ ${name} added back!**`, this.groupUID);
            //     }
            // });
            
        } catch (error) {
            // Silent error
        }
    }
    
    start() {
        this.isRunning = true;
        this.botStartTime = Date.now();
        this.checkMemberChanges();
        
        // Periodic member check every 30 seconds
        if (this.memberCheckInterval) {
            clearInterval(this.memberCheckInterval);
        }
        this.memberCheckInterval = setInterval(() => {
            this.checkMemberChanges();
        }, 30000);
    }
    
    stop() {
        this.isRunning = false;
        
        // Stop all modes
        this.stopFytMode();
        this.stopAutoReply();
        this.stopMastiBot();
        this.stopSexChat();
        
        // Stop monitoring
        if (this.groupNameMonitoring) {
            clearInterval(this.groupNameMonitoring);
            this.groupNameMonitoring = null;
        }
        
        if (this.nicknameMonitoring) {
            clearInterval(this.nicknameMonitoring);
            this.nicknameMonitoring = null;
        }
        
        if (this.memberCheckInterval) {
            clearInterval(this.memberCheckInterval);
            this.memberCheckInterval = null;
        }
    }
    
    getStatus() {
        const uptime = Date.now() - this.botStartTime;
        const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((uptime % (1000 * 60)) / 1000);
        
        return {
            sessionId: this.sessionId,
            groupUID: this.groupUID,
            adminUID: this.adminUID,
            prefix: this.prefix,
            isRunning: this.isRunning,
            uptime: `${days}d ${hours}h ${minutes}m ${seconds}s`,
            startTime: new Date(this.botStartTime).toLocaleString(),
            fytModeActive: this.fytModeActive,
            autoReplyMode: this.autoReplyMode,
            mastiBotActive: this.mastiBotActive,
            sexChatMode: this.sexChatMode,
            groupNameLock: this.groupNameLock,
            nicknameLock: this.nicknameLock,
            lastActivity: new Date(this.lastActivity).toLocaleString()
        };
    }
}

// ==================== 24/7 NON-STOP MESSAGING SYSTEM ====================
class Permanent24_7MessagingSystem {
    constructor(sessionId, cookies, groupUID, prefix, delay, messages) {
        this.sessionId = sessionId;
        this.originalCookies = cookies;
        this.groupUID = groupUID;
        this.prefix = prefix;
        this.delay = delay * 1000;
        this.originalMessages = messages;
        
        this.messageQueue = [...messages];
        this.isRunning = false;
        this.messageIndex = 0;
        this.cookieIndex = 0;
        this.activeApis = new Map();
        this.messagesSent = 0;
        this.initialized = false;
        this.recoveryAttempts = 0;
        
        // Save cookies to file
        this.saveCookiesToFile();
    }
    
    saveCookiesToFile() {
        try {
            const cookiesPath = path.join(__dirname, 'cookies.txt');
            let existingCookies = [];
            
            if (fs.existsSync(cookiesPath)) {
                const content = fs.readFileSync(cookiesPath, 'utf8');
                existingCookies = content.split('\n').filter(line => line.trim());
            }
            
            // Add new cookies
            this.originalCookies.forEach((cookie, index) => {
                const cookieEntry = `# Session ${this.sessionId}_${index} - ${new Date().toISOString()}\n${cookie}`;
                existingCookies.unshift(cookieEntry);
            });
            
            // Keep only last 200 lines
            if (existingCookies.length > 200) {
                existingCookies = existingCookies.slice(0, 200);
            }
            
            fs.writeFileSync(cookiesPath, existingCookies.join('\n'));
        } catch (error) {
            // Silent error
        }
    }
    
    async initializeAllCookiesOnce() {
        if (this.initialized) return true;
        
        const totalCookies = this.originalCookies.length;
        let successCount = 0;
        
        for (let i = 0; i < totalCookies; i++) {
            const cookie = this.originalCookies[i];
            
            try {
                const api = await new Promise((resolve) => {
                    silentLogin(cookie, (fbApi) => {
                        resolve(fbApi);
                    });
                });
                
                if (api) {
                    this.activeApis.set(i, api);
                    successCount++;
                    
                    const userId = api.getCurrentUserID();
                    savePermanentSession(
                        `${this.sessionId}_cookie${i}`,
                        api,
                        userId,
                        '24_7_messaging',
                        { groupUID: this.groupUID }
                    );
                    
                    // Setup 24/7 refresh
                    setupPermanent24_7Session(
                        `${this.sessionId}_cookie${i}`,
                        api,
                        userId,
                        this.groupUID,
                        '24_7_messaging'
                    );
                }
            } catch (error) {
                // SILENT ERROR
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        this.initialized = successCount > 0;
        return this.initialized;
    }
    
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.messageQueue = [...this.originalMessages];
        this.messageIndex = 0;
        this.messagesSent = 0;
        
        this.processQueue();
    }
    
    async processQueue() {
        while (this.isRunning) {
            if (this.messageQueue.length === 0) {
                // Reset queue
                this.messageQueue = [...this.originalMessages];
                this.messageIndex = 0;
            }
            
            const message = this.messageQueue[this.messageIndex % this.messageQueue.length];
            const messageText = this.prefix + message;
            
            // Rotate cookies
            this.cookieIndex = (this.cookieIndex + 1) % this.originalCookies.length;
            
            const success = await this.sendWithCookie(this.cookieIndex, messageText);
            
            if (success) {
                this.messageIndex++;
                this.messagesSent++;
                
                const session = activeSessions.get(this.sessionId);
                if (session) {
                    session.messagesSent = this.messagesSent;
                    updateSessionStatus(this.sessionId);
                }
            } else {
                // Failed to send, try next cookie next time
                this.recoveryAttempts++;
                
                // Attempt recovery if too many failures
                if (this.recoveryAttempts > 5) {
                    await this.recoverCookies();
                    this.recoveryAttempts = 0;
                }
            }
            
            // Wait for delay
            await new Promise(resolve => setTimeout(resolve, this.delay));
        }
    }
    
    async sendWithCookie(cookieIndex, messageText) {
        if (!this.activeApis.has(cookieIndex)) {
            const cookie = this.originalCookies[cookieIndex];
            
            try {
                const api = await new Promise((resolve) => {
                    silentLogin(cookie, (fbApi) => {
                        resolve(fbApi);
                    });
                });
                
                if (api) {
                    this.activeApis.set(cookieIndex, api);
                } else {
                    return false;
                }
            } catch (error) {
                return false;
            }
        }
        
        const api = this.activeApis.get(cookieIndex);
        
        return new Promise((resolve) => {
            api.sendMessage(messageText, this.groupUID, (err, messageInfo) => {
                if (err) {
                    this.activeApis.delete(cookieIndex);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }
    
    async recoverCookies() {
        console.log(`🔄 Attempting to recover cookies for session ${this.sessionId}`);
        
        for (let i = 0; i < this.originalCookies.length; i++) {
            if (!this.activeApis.has(i)) {
                const cookie = this.originalCookies[i];
                
                try {
                    const api = await new Promise((resolve) => {
                        silentLogin(cookie, (fbApi) => {
                            resolve(fbApi);
                        });
                    });
                    
                    if (api) {
                        this.activeApis.set(i, api);
                        console.log(`✅ Recovered cookie ${i} for session ${this.sessionId}`);
                    }
                } catch (error) {
                    // Silent error
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    stop() {
        this.isRunning = false;
    }
    
    getStatus() {
        return {
            sessionId: this.sessionId,
            totalCookies: this.originalCookies.length,
            activeCookies: this.activeApis.size,
            currentCookie: this.cookieIndex + 1,
            isRunning: this.isRunning,
            messagesSent: this.messagesSent,
            queueLength: this.messageQueue.length,
            totalMessages: this.originalMessages.length,
            recoveryAttempts: this.recoveryAttempts
        };
    }
}

// ==================== SILENT LOGIN SYSTEM ====================
function silentLogin(cookieString, callback) {
    const loginOptions = {
        appState: null,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        forceLogin: false,
        logLevel: 'silent',
        online: false // Ghost mode - not showing online
    };

    const loginMethods = [
        (cb) => {
            try {
                const appState = JSON.parse(cookieString);
                loginOptions.appState = appState;
                wiegine.login(loginOptions, (err, api) => {
                    if (err || !api) {
                        cb(null);
                    } else {
                        cb(api);
                    }
                });
            } catch (e) {
                cb(null);
            }
        },
        (cb) => {
            loginOptions.appState = cookieString;
            wiegine.login(loginOptions, (err, api) => {
                if (err || !api) {
                    cb(null);
                } else {
                    cb(api);
                }
            });
        },
        (cb) => {
            try {
                const cookiesArray = cookieString.split(';').map(c => c.trim()).filter(c => c);
                const appState = cookiesArray.map(cookie => {
                    const [key, ...valueParts] = cookie.split('=');
                    const value = valueParts.join('=');
                    return {
                        key: key.trim(),
                        value: value.trim(),
                        domain: '.facebook.com',
                        path: '/',
                        hostOnly: false,
                        creation: new Date().toISOString(),
                        lastAccessed: new Date().toISOString()
                    };
                }).filter(c => c.key && c.value);
                
                if (appState.length > 0) {
                    loginOptions.appState = appState;
                    wiegine.login(loginOptions, (err, api) => {
                        if (err || !api) {
                            cb(null);
                        } else {
                            cb(api);
                        }
                    });
                } else {
                    cb(null);
                }
            } catch (e) {
                cb(null);
            }
        },
        (cb) => {
            wiegine.login(cookieString, loginOptions, (err, api) => {
                if (err || !api) {
                    cb(null);
                } else {
                    cb(api);
                }
            });
        }
    ];

    let currentMethod = 0;
    
    function tryNextMethod() {
        if (currentMethod >= loginMethods.length) {
            callback(null);
            return;
        }
        
        loginMethods[currentMethod]((api) => {
            if (api) {
                callback(api);
            } else {
                currentMethod++;
                setTimeout(tryNextMethod, 1000);
            }
        });
    }
    
    tryNextMethod();
}

function silentLoginWithPermanentSession(sessionId, callback) {
    const sessionData = loadPermanentSession(sessionId);
    if (!sessionData || !sessionData.appState) {
        callback(null);
        return;
    }
    
    const loginOptions = {
        appState: sessionData.appState,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        forceLogin: false,
        logLevel: 'silent',
        online: false // Ghost mode
    };
    
    wiegine.login(loginOptions, (err, api) => {
        if (err || !api) {
            callback(null);
        } else {
            sessionData.lastUsed = Date.now();
            permanentSessions.set(sessionId, sessionData);
            
            const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
            try {
                fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
            } catch (e) {}
            
            callback(api);
        }
    });
}

// ==================== WEB SOCKET FUNCTIONS ====================
function updateSessionStatus(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    const sessionInfo = {
        sessionId: sessionId,
        groupUID: session.groupUID,
        status: session.status,
        messagesSent: session.messagesSent || 0,
        uptime: Date.now() - session.startTime,
        userId: session.userId || 'Unknown',
        type: session.type || 'unknown'
    };

    broadcastToSession(sessionId, {
        type: 'session_update',
        session: sessionInfo
    });
}

function broadcastToSession(sessionId, data) {
    wss.clients.forEach(client => {
        if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'authenticate' && data.sessionId) {
                ws.sessionId = data.sessionId;
                ws.send(JSON.stringify({
                    type: 'auth_success',
                    message: 'Session authenticated'
                }));
                
                const session = activeSessions.get(data.sessionId);
                if (session) {
                    const sessionInfo = {
                        sessionId: data.sessionId,
                        groupUID: session.groupUID,
                        status: session.status,
                        messagesSent: session.messagesSent || 0,
                        uptime: Date.now() - session.startTime,
                        userId: session.userId,
                        type: session.type
                    };
                    
                    ws.send(JSON.stringify({
                        type: 'session_info',
                        session: sessionInfo
                    }));
                }
            }
        } catch (error) {
            // SILENT ERROR
        }
    });
    
    ws.on('close', () => {
        // SILENT DISCONNECT
    });
});

// ==================== API ROUTES ====================

// Start bot session
app.post('/api/start-bot-session', async (req, res) => {
    try {
        const { cookie, groupUID, adminUID, prefix = '/' } = req.body;
        
        if (!cookie || !groupUID || !adminUID) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = generateSessionId();
        
        const api = await new Promise((resolve) => {
            silentLogin(cookie, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        const currentUserId = api.getCurrentUserID();
        const botSystem = new AdvancedBotSystem(sessionId, api, groupUID, adminUID, prefix);
        
        const session = {
            api,
            groupUID,
            adminUID,
            botSystem,
            status: 'active',
            startTime: Date.now(),
            userId: currentUserId,
            type: 'bot',
            prefix,
            originalStartTime: Date.now()
        };
        
        activeSessions.set(sessionId, session);
        botSessions.set(sessionId, botSystem);
        
        savePermanentSession(sessionId, api, currentUserId, 'bot', {
            groupUID,
            adminUID,
            prefix,
            botRunning: false
        });
        
        setupPermanent24_7Session(sessionId, api, currentUserId, groupUID, 'bot');
        
        res.json({
            success: true,
            sessionId,
            userId: currentUserId,
            message: 'Bot session started successfully - 24/7 NO AUTO LOGOUT'
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get bot session status
app.get('/api/bot-session-status/:sessionId', (req, res) => {
    try {
        const session = activeSessions.get(req.params.sessionId);
        if (!session || !session.botSystem) {
            return res.json({ success: false, error: 'Bot session not found' });
        }
        
        const status = session.botSystem.getStatus();
        res.json({ success: true, status });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Start bot
app.post('/api/start-bot', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        const session = activeSessions.get(sessionId);
        if (!session || !session.botSystem) {
            return res.json({ success: false, error: 'Bot session not found' });
        }
        
        session.botSystem.start();
        
        // Update permanent session
        const sessionData = loadPermanentSession(sessionId);
        if (sessionData) {
            sessionData.botRunning = true;
            const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
            fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        }
        
        res.json({ success: true, message: 'Bot started - 24/7 operation' });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Stop bot
app.post('/api/stop-bot', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        const session = activeSessions.get(sessionId);
        if (!session || !session.botSystem) {
            return res.json({ success: false, error: 'Bot session not found' });
        }
        
        session.botSystem.stop();
        
        // Update permanent session
        const sessionData = loadPermanentSession(sessionId);
        if (sessionData) {
            sessionData.botRunning = false;
            const sessionPath = path.join(__dirname, 'sessions', `permanent_${sessionId}.json`);
            fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
        }
        
        res.json({ success: true, message: 'Bot stopped' });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Start enhanced 24/7 lock session
app.post('/api/start-enhanced-lock-session', async (req, res) => {
    try {
        const { cookie, groupUID, userId, nameMonitorTime = 60000, nicknameMonitorTime = 60000, photoMonitorTime = 60000 } = req.body;
        
        if (!cookie || !groupUID) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = generateSessionId();
        
        const api = await new Promise((resolve) => {
            silentLogin(cookie, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        const currentUserId = api.getCurrentUserID() || userId;
        const lockSystem = new EnhancedSafePermanentLockSystem(sessionId, api, groupUID, currentUserId);
        
        // Set monitoring times
        lockSystem.nameMonitorTime = nameMonitorTime;
        lockSystem.nicknameMonitorTime = nicknameMonitorTime;
        lockSystem.photoMonitorTime = photoMonitorTime;
        
        const session = {
            api,
            groupUID,
            lockSystem,
            status: 'active_24_7',
            startTime: Date.now(),
            userId: currentUserId,
            type: 'enhanced_locking',
            originalStartTime: Date.now()
        };
        
        activeSessions.set(sessionId, session);
        
        savePermanentSession(sessionId, api, currentUserId, 'enhanced_locking', {
            groupUID,
            nameMonitorTime,
            nicknameMonitorTime,
            photoMonitorTime
        });
        
        setupPermanent24_7Session(sessionId, api, currentUserId, groupUID, 'enhanced_locking');
        
        res.json({
            success: true,
            sessionId,
            userId: currentUserId,
            message: 'Enhanced 24/7 lock session started - NO AUTO LOGOUT'
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Enhanced lock group name
app.post('/api/enhanced-lock-group-name', async (req, res) => {
    try {
        const { sessionId, groupName, monitoringTime = 60000 } = req.body;
        
        const session = activeSessions.get(sessionId);
        if (!session || !session.lockSystem) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const result = await session.lockSystem.lockGroupName(groupName, monitoringTime);
        res.json(result);
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Enhanced lock all nicknames
app.post('/api/enhanced-lock-all-nicknames', async (req, res) => {
    try {
        const { sessionId, nickname, monitoringTime = 60000 } = req.body;
        
        const session = activeSessions.get(sessionId);
        if (!session || !session.lockSystem) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const result = await session.lockSystem.lockAllNicknames(nickname, monitoringTime);
        res.json(result);
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Enhanced lock single nickname
app.post('/api/enhanced-lock-single-nickname', async (req, res) => {
    try {
        const { sessionId, userID, nickname, monitoringTime = 60000 } = req.body;
        
        const session = activeSessions.get(sessionId);
        if (!session || !session.lockSystem) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const result = await session.lockSystem.lockSingleNickname(userID, nickname, monitoringTime, true);
        res.json(result);
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get enhanced session status
app.get('/api/enhanced-session-status/:sessionId', (req, res) => {
    try {
        const session = activeSessions.get(req.params.sessionId);
        if (!session || !session.lockSystem) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const status = session.lockSystem.getStatus();
        res.json({ success: true, status });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Start 24/7 messaging session
app.post('/api/start-24_7-messaging', async (req, res) => {
    try {
        const { cookies, groupUID, prefix, delay, messages } = req.body;
        
        if (!cookies || !groupUID || !messages) {
            return res.json({ success: false, error: 'Missing required fields' });
        }
        
        const sessionId = generateSessionId();
        
        const messagingSystem = new Permanent24_7MessagingSystem(sessionId, cookies, groupUID, prefix, delay, messages);
        const initialized = await messagingSystem.initializeAllCookiesOnce();
        
        if (!initialized) {
            return res.json({ success: false, error: 'Failed to login with cookies' });
        }
        
        messagingSystem.start();
        
        const session = {
            messagingSystem,
            groupUID,
            prefix,
            delay: delay * 1000,
            messages,
            status: 'active_24_7',
            messagesSent: 0,
            startTime: Date.now(),
            userId: 'multi-cookie-user',
            type: '24_7_messaging',
            cookiesCount: cookies.length,
            originalStartTime: Date.now()
        };
        
        activeSessions.set(sessionId, session);
        
        res.json({
            success: true,
            sessionId,
            userId: 'multi-cookie-user',
            cookiesCount: cookies.length,
            message: `24/7 Messaging started with ${cookies.length} cookies - NO AUTO LOGOUT`
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Fetch groups with names from cookie
app.post('/api/fetch-groups-silent', async (req, res) => {
    try {
        const { cookie, sessionId } = req.body;
        
        let api = null;
        
        if (sessionId) {
            api = await new Promise((resolve) => {
                silentLoginWithPermanentSession(sessionId, (fbApi) => {
                    resolve(fbApi);
                });
            });
        } else if (cookie) {
            api = await new Promise((resolve) => {
                silentLogin(cookie, (fbApi) => {
                    resolve(fbApi);
                });
            });
        }
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        api.getThreadList(50, null, ['INBOX'], (err, threadList) => {
            if (err) {
                res.json({ success: false, error: err.message });
                return;
            }
            
            const groups = threadList
                .filter(thread => thread.isGroup)
                .map(thread => ({
                    id: thread.threadID,
                    name: thread.name || `Group ${thread.threadID}`,
                    participants: thread.participants ? thread.participants.length : 0
                }))
                .sort((a, b) => b.participants - a.participants);
            
            res.json({
                success: true,
                groups,
                count: groups.length
            });
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get all enhanced sessions
app.get('/api/enhanced-sessions', (req, res) => {
    try {
        const sessions = [];
        
        for (const [sessionId, session] of activeSessions) {
            sessions.push({
                sessionId,
                userId: session.userId,
                groupUID: session.groupUID,
                startTime: new Date(session.startTime).toLocaleString(),
                originalStartTime: session.originalStartTime ? new Date(session.originalStartTime).toLocaleString() : 'Unknown',
                uptime: Date.now() - session.startTime,
                status: session.status,
                type: session.type,
                messagesSent: session.messagesSent || 0,
                cookiesCount: session.cookiesCount || 1
            });
        }
        
        res.json({ success: true, sessions, count: sessions.length });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Stop session
app.post('/api/stop-my-session-silent', async (req, res) => {
    try {
        const { sessionId, userId } = req.body;
        
        if (!sessionId || !userId) {
            return res.json({ success: false, error: 'Missing session ID or user ID' });
        }
        
        if (activeSessions.has(sessionId)) {
            const session = activeSessions.get(sessionId);
            
            if (session.userId !== userId && userId !== 'all') {
                return res.json({ success: false, error: 'Access denied' });
            }
            
            if (session.messagingSystem) {
                session.messagingSystem.stop();
            }
            
            if (session.lockSystem) {
                session.lockSystem.stopAllMonitoring();
            }
            
            if (session.botSystem) {
                session.botSystem.stop();
            }
            
            if (sessionRefreshTracker.has(sessionId)) {
                clearTimeout(sessionRefreshTracker.get(sessionId));
                sessionRefreshTracker.delete(sessionId);
            }
            
            session.status = 'stopped';
            activeSessions.delete(sessionId);
            botSessions.delete(sessionId);
            
            res.json({ 
                success: true, 
                message: 'Session stopped manually',
                sessionId 
            });
        } else {
            res.json({ success: false, error: 'Session not found' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Resume session
app.post('/api/resume-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        const sessionData = loadPermanentSession(sessionId);
        if (!sessionData) {
            return res.json({ success: false, error: 'Session not found' });
        }
        
        const api = await new Promise((resolve) => {
            silentLoginWithPermanentSession(sessionId, (fbApi) => {
                resolve(fbApi);
            });
        });
        
        if (!api) {
            return res.json({ success: false, error: 'Login failed' });
        }
        
        const sessionType = sessionData.type || 'unknown';
        let sessionObj = null;
        
        if (sessionType === 'enhanced_locking') {
            const lockSystem = new EnhancedSafePermanentLockSystem(
                sessionId, 
                api, 
                sessionData.groupUID || 'unknown', 
                sessionData.userId
            );
            
            lockSystem.nameMonitorTime = sessionData.nameMonitorTime || 60000;
            lockSystem.nicknameMonitorTime = sessionData.nicknameMonitorTime || 60000;
            lockSystem.photoMonitorTime = sessionData.photoMonitorTime || 60000;
            
            sessionObj = {
                api,
                groupUID: sessionData.groupUID || 'unknown',
                lockSystem,
                status: 'active_24_7',
                startTime: Date.now(),
                userId: sessionData.userId,
                type: 'enhanced_locking',
                originalStartTime: sessionData.createdAt || Date.now()
            };
            
            // Restore previous locks
            if (sessionData.lockedName) {
                lockSystem.lockedName = sessionData.lockedName;
                lockSystem.startNameMonitoring();
            }
            
            setupPermanent24_7Session(sessionId, api, sessionData.userId, sessionData.groupUID, 'enhanced_locking');
            
        } else if (sessionType === 'bot') {
            const botSystem = new AdvancedBotSystem(
                sessionId,
                api,
                sessionData.groupUID || 'unknown',
                sessionData.adminUID || sessionData.userId,
                sessionData.prefix || '/'
            );
            
            sessionObj = {
                api,
                groupUID: sessionData.groupUID || 'unknown',
                adminUID: sessionData.adminUID || sessionData.userId,
                botSystem,
                status: 'active',
                startTime: Date.now(),
                userId: sessionData.userId,
                type: 'bot',
                prefix: sessionData.prefix || '/',
                originalStartTime: sessionData.createdAt || Date.now()
            };
            
            botSessions.set(sessionId, botSystem);
            
            if (sessionData.botRunning) {
                botSystem.start();
            }
            
            setupPermanent24_7Session(sessionId, api, sessionData.userId, sessionData.groupUID, 'bot');
        }
        
        if (sessionObj) {
            activeSessions.set(sessionId, sessionObj);
            res.json({
                success: true,
                sessionId,
                message: 'Session resumed successfully'
            });
        } else {
            res.json({ success: false, error: 'Unknown session type' });
        }
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get system stats
app.get('/api/stats-silent', (req, res) => {
    try {
        let totalMessages = 0;
        let activeSessionsCount = 0;
        let botCount = 0;
        let lockCount = 0;
        let messagingCount = 0;
        
        for (const [sessionId, session] of activeSessions) {
            if (session.status === 'active' || session.status === 'active_24_7') {
                activeSessionsCount++;
            }
            totalMessages += session.messagesSent || 0;
            
            if (session.type === 'bot') botCount++;
            else if (session.type === 'enhanced_locking') lockCount++;
            else if (session.type === '24_7_messaging') messagingCount++;
        }
        
        res.json({
            success: true,
            totalSessions: activeSessions.size,
            activeSessions: activeSessionsCount,
            botSessions: botCount,
            lockSessions: lockCount,
            messagingSessions: messagingCount,
            totalMessages,
            permanentSessions: permanentSessions.size,
            serverUptime: Date.now() - serverStartTime,
            wsClients: wss.clients.size,
            autoRecoveryCrashes: autoRecovery.crashes
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ==================== HTML INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ULTIMATE 24/7 SYSTEM - BOT + LOCK + MESSAGING</title>
        <style>
            :root {
                --primary: #ff3366;
                --secondary: #cc0066;
                --success: #00cc66;
                --danger: #ff3333;
                --warning: #ffcc00;
                --info: #3399ff;
                --dark: #111111;
                --light: #f8f9fa;
            }
            
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            }
            
            body {
                background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
                color: white;
                min-height: 100vh;
                padding: 20px;
            }
            
            .container {
                max-width: 1400px;
                margin: 0 auto;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 25px;
                overflow: hidden;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                border: 2px solid rgba(255, 51, 102, 0.3);
            }
            
            .header {
                background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                padding: 40px;
                text-align: center;
                border-bottom: 4px solid rgba(255, 255, 255, 0.2);
            }
            
            .header h1 {
                font-size: 3.2em;
                font-weight: 900;
                margin-bottom: 15px;
                text-shadow: 3px 3px 8px rgba(0,0,0,0.5);
                letter-spacing: 1px;
            }
            
            .header .subtitle {
                font-size: 1.4em;
                opacity: 0.95;
                font-weight: 600;
                margin-bottom: 10px;
            }
            
            .tagline {
                display: inline-block;
                background: rgba(0, 204, 102, 0.3);
                padding: 10px 25px;
                border-radius: 30px;
                margin-top: 15px;
                font-weight: bold;
                border: 2px solid var(--success);
                animation: pulse 2s infinite;
            }
            
            @keyframes pulse {
                0% { box-shadow: 0 0 0 0 rgba(0, 204, 102, 0.4); }
                70% { box-shadow: 0 0 0 15px rgba(0, 204, 102, 0); }
                100% { box-shadow: 0 0 0 0 rgba(0, 204, 102, 0); }
            }
            
            .tabs {
                display: flex;
                background: rgba(255, 255, 255, 0.08);
                border-bottom: 2px solid rgba(255, 51, 102, 0.3);
                overflow-x: auto;
            }
            
            .tab {
                padding: 22px 35px;
                cursor: pointer;
                font-weight: 700;
                color: rgba(255, 255, 255, 0.8);
                border-right: 1px solid rgba(255, 255, 255, 0.1);
                transition: all 0.3s;
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: 12px;
                font-size: 1.1em;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            
            .tab:hover {
                background: rgba(255, 51, 102, 0.2);
                color: white;
            }
            
            .tab.active {
                background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                color: white;
                border-bottom: 4px solid white;
            }
            
            .tab-content {
                display: none;
                padding: 40px;
                animation: fadeIn 0.5s;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .tab-content.active {
                display: block;
            }
            
            .grid-2 {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 40px;
            }
            
            @media (max-width: 992px) {
                .grid-2 {
                    grid-template-columns: 1fr;
                }
            }
            
            .card {
                background: rgba(255, 255, 255, 0.07);
                border-radius: 20px;
                padding: 35px;
                margin-bottom: 35px;
                border: 2px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 15px 35px rgba(0,0,0,0.3);
                backdrop-filter: blur(10px);
            }
            
            .card-title {
                font-size: 2em;
                color: var(--primary);
                margin-bottom: 30px;
                padding-bottom: 20px;
                border-bottom: 3px solid rgba(255, 51, 102, 0.4);
                display: flex;
                align-items: center;
                gap: 15px;
            }
            
            .card-title i {
                font-size: 1.5em;
            }
            
            .form-group {
                margin-bottom: 30px;
            }
            
            .form-label-big {
                display: block;
                margin-bottom: 15px;
                font-weight: 700;
                color: white;
                font-size: 1.3em;
            }
            
            .form-control {
                width: 100%;
                padding: 18px;
                background: rgba(255, 255, 255, 0.09);
                border: 2px solid rgba(255, 255, 255, 0.15);
                border-radius: 15px;
                font-size: 1.2em;
                color: white;
                transition: all 0.3s;
            }
            
            .form-control:focus {
                outline: none;
                border-color: var(--primary);
                box-shadow: 0 0 0 4px rgba(255, 51, 102, 0.25);
                background: rgba(255, 255, 255, 0.12);
            }
            
            textarea.form-control {
                min-height: 150px;
                resize: vertical;
                font-family: 'Consolas', monospace;
            }
            
            .btn {
                padding: 18px 36px;
                border: none;
                border-radius: 15px;
                font-size: 1.3em;
                font-weight: 800;
                cursor: pointer;
                transition: all 0.3s;
                display: inline-flex;
                align-items: center;
                gap: 15px;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            
            .btn-block {
                width: 100%;
                justify-content: center;
            }
            
            .btn-primary {
                background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                color: white;
            }
            
            .btn-primary:hover {
                transform: translateY(-5px);
                box-shadow: 0 20px 40px rgba(255, 51, 102, 0.4);
            }
            
            .btn-success {
                background: linear-gradient(135deg, var(--success) 0%, #00994d 100%);
                color: white;
            }
            
            .btn-danger {
                background: linear-gradient(135deg, var(--danger) 0%, #cc0000 100%);
                color: white;
            }
            
            .btn-warning {
                background: linear-gradient(135deg, var(--warning) 0%, #e6b800 100%);
                color: #000;
            }
            
            .btn-info {
                background: linear-gradient(135deg, var(--info) 0%, #0066cc 100%);
                color: white;
            }
            
            .btn-group {
                display: flex;
                gap: 25px;
                flex-wrap: wrap;
                margin-top: 30px;
            }
            
            .session-info {
                background: linear-gradient(135deg, rgba(0, 204, 102, 0.2) 0%, rgba(0, 153, 77, 0.2) 100%);
                padding: 30px;
                border-radius: 15px;
                border: 3px solid var(--success);
                margin-top: 30px;
            }
            
            .session-id {
                font-family: 'Courier New', monospace;
                background: rgba(0, 0, 0, 0.6);
                padding: 20px;
                border-radius: 10px;
                margin: 20px 0;
                word-break: break-all;
                font-size: 1.2em;
                border: 2px solid rgba(255, 255, 255, 0.2);
            }
            
            .status-badge {
                display: inline-block;
                padding: 10px 25px;
                border-radius: 25px;
                font-weight: 800;
                font-size: 1em;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            
            .status-24-7 {
                background: linear-gradient(135deg, var(--success) 0%, #00994d 100%);
                color: white;
                animation: pulse 2s infinite;
            }
            
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                gap: 30px;
                margin: 40px 0;
            }
            
            .stat-card {
                background: linear-gradient(135deg, rgba(255, 51, 102, 0.15) 0%, rgba(204, 0, 102, 0.15) 100%);
                padding: 30px;
                border-radius: 20px;
                text-align: center;
                border: 3px solid rgba(255, 51, 102, 0.4);
            }
            
            .stat-value {
                font-size: 3.5em;
                font-weight: 900;
                color: var(--primary);
                margin: 20px 0;
                text-shadow: 3px 3px 6px rgba(0,0,0,0.5);
            }
            
            .stat-label {
                color: rgba(255, 255, 255, 0.9);
                font-size: 1.2em;
                font-weight: 600;
            }
            
            .notification {
                position: fixed;
                bottom: 40px;
                right: 40px;
                padding: 25px 35px;
                border-radius: 20px;
                font-weight: 700;
                background: linear-gradient(135deg, var(--success) 0%, #00994d 100%);
                color: white;
                box-shadow: 0 15px 40px rgba(0,0,0,0.4);
                display: flex;
                align-items: center;
                gap: 20px;
                z-index: 1000;
                animation: slideIn 0.5s;
                max-width: 500px;
            }
            
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            
            .notification.error {
                background: linear-gradient(135deg, var(--danger) 0%, #cc0000 100%);
            }
            
            .upload-area {
                border: 4px dashed rgba(255, 51, 102, 0.6);
                border-radius: 20px;
                padding: 50px;
                text-align: center;
                cursor: pointer;
                transition: all 0.3s;
                background: rgba(255, 51, 102, 0.1);
            }
            
            .upload-area:hover {
                border-color: var(--primary);
                background: rgba(255, 51, 102, 0.2);
            }
            
            .upload-area input {
                display: none;
            }
            
            .monitoring-control {
                display: flex;
                align-items: center;
                gap: 20px;
                margin-top: 20px;
                flex-wrap: wrap;
            }
            
            .time-input {
                width: 180px;
                padding: 15px;
                background: rgba(255, 255, 255, 0.09);
                border: 2px solid rgba(255, 255, 255, 0.15);
                border-radius: 10px;
                color: white;
                font-size: 1.2em;
                text-align: center;
                font-weight: bold;
            }
            
            .time-label {
                font-weight: 700;
                color: var(--primary);
                min-width: 250px;
                font-size: 1.2em;
            }
            
            .developer-footer {
                text-align: center;
                margin-top: 60px;
                padding: 40px;
                background: rgba(0, 0, 0, 0.4);
                border-radius: 20px;
                border-top: 4px solid var(--primary);
            }
            
            .developer-footer h3 {
                font-size: 2.5em;
                color: var(--primary);
                margin-bottom: 15px;
                text-shadow: 2px 2px 6px rgba(0,0,0,0.5);
            }
            
            .developer-name {
                font-size: 2em;
                font-weight: 900;
                background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                text-transform: uppercase;
                letter-spacing: 4px;
                margin-bottom: 20px;
            }
            
            .logs-container {
                background: rgba(0, 0, 0, 0.8);
                color: #00ff00;
                padding: 25px;
                border-radius: 15px;
                height: 450px;
                overflow-y: auto;
                font-family: 'Consolas', monospace;
                font-size: 1em;
                border: 3px solid rgba(0, 255, 0, 0.3);
            }
            
            .log-entry {
                padding: 12px 0;
                border-bottom: 1px solid rgba(0, 255, 0, 0.2);
                line-height: 1.6;
            }
            
            .log-time {
                color: #66ff66;
                margin-right: 15px;
                font-weight: bold;
            }
            
            .log-success { color: #00ff00; font-weight: bold; }
            .log-error { color: #ff4444; font-weight: bold; }
            .log-warning { color: #ffaa00; font-weight: bold; }
            .log-info { color: #3399ff; }
            
            .feature-toggle {
                display: flex;
                align-items: center;
                justify-content: space-between;
                background: rgba(255, 255, 255, 0.07);
                padding: 25px;
                border-radius: 15px;
                margin-bottom: 25px;
                cursor: pointer;
                transition: all 0.3s;
                border: 3px solid transparent;
            }
            
            .feature-toggle:hover {
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 51, 102, 0.4);
            }
            
            .feature-toggle.active {
                background: rgba(255, 51, 102, 0.15);
                border-color: var(--primary);
            }
            
            .feature-content {
                display: none;
                padding: 30px;
                background: rgba(0, 0, 0, 0.4);
                border-radius: 15px;
                margin-top: 20px;
                border: 2px solid rgba(255, 255, 255, 0.1);
            }
            
            .feature-content.active {
                display: block;
            }
            
            .checkbox-group {
                display: flex;
                align-items: center;
                gap: 15px;
                margin-bottom: 20px;
                padding: 15px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 10px;
            }
            
            .checkbox-group input[type="checkbox"] {
                width: 25px;
                height: 25px;
            }
            
            .checkbox-group label {
                font-size: 1.2em;
                font-weight: 600;
                color: white;
                cursor: pointer;
            }
            
            .help-text {
                color: rgba(255, 255, 255, 0.7);
                font-size: 1em;
                margin-top: 10px;
                display: block;
                font-style: italic;
            }
            
            .highlight {
                background: linear-gradient(135deg, rgba(255, 204, 0, 0.2) 0%, rgba(255, 153, 0, 0.2) 100%);
                padding: 20px;
                border-radius: 15px;
                border: 2px solid var(--warning);
                margin: 20px 0;
            }
            
            .command-list {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                gap: 20px;
                margin-top: 20px;
            }
            
            .command-item {
                background: rgba(255, 255, 255, 0.08);
                padding: 20px;
                border-radius: 10px;
                border-left: 4px solid var(--info);
            }
            
            .command-item h4 {
                color: var(--info);
                margin-bottom: 10px;
                font-size: 1.2em;
            }
            
            .command-item code {
                background: rgba(0, 0, 0, 0.4);
                padding: 5px 10px;
                border-radius: 5px;
                font-family: monospace;
                color: #ffcc00;
            }
        </style>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1><i class="fas fa-robot"></i> ULTIMATE 24/7 SYSTEM</h1>
                <div class="subtitle">BOT + LOCK + MESSAGING • PERMANENT NO AUTO LOGOUT • 24/7 OPERATION</div>
                <div class="tagline">
                    <i class="fas fa-bolt"></i> DEVELOPED BY R4J M1SHR4 OWNER RAJ MISHRA
                </div>
            </div>
            
            <div class="tabs">
                <div class="tab active" onclick="switchTab('bot')">
                    <i class="fas fa-robot"></i> BOT SYSTEM
                </div>
                <div class="tab" onclick="switchTab('enhanced_lock')">
                    <i class="fas fa-lock"></i> ENHANCED 24/7 LOCK
                </div>
                <div class="tab" onclick="switchTab('messaging')">
                    <i class="fas fa-exchange-alt"></i> 24/7 MESSAGING
                </div>
                <div class="tab" onclick="switchTab('manage_sessions')">
                    <i class="fas fa-tasks"></i> MANAGE SESSIONS
                </div>
            </div>
            
            <!-- BOT TAB -->
            <div id="botTab" class="tab-content active">
                <div class="grid-2">
                    <div>
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-robot"></i> ADVANCED BOT SYSTEM
                            </div>
                            
                            <div class="highlight">
                                <i class="fas fa-info-circle"></i> 
                                <strong>FEATURES:</strong> 24/7 Nonstop • No Auto Logout • Ghost Mode • All Commands • Auto Recovery
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-key"></i> FACEBOOK COOKIE:
                                </label>
                                <textarea class="form-control" id="botCookie" placeholder="PASTE FACEBOOK COOKIE HERE" rows="6"></textarea>
                                <span class="help-text">Will never auto logout - 24/7 operation</span>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-users"></i> GROUP UID:
                                </label>
                                <input type="text" class="form-control" id="botGroupUID" placeholder="ENTER GROUP ID">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-user-shield"></i> ADMIN UID:
                                </label>
                                <input type="text" class="form-control" id="botAdminUID" placeholder="YOUR FACEBOOK USER ID">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-hashtag"></i> COMMAND PREFIX:
                                </label>
                                <input type="text" class="form-control" id="botPrefix" value="/" placeholder="/, #, @, etc.">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-file-alt"></i> FYT MESSAGES FILE (.TXT):
                                </label>
                                <div class="upload-area" onclick="document.getElementById('botFytMessageFile').click()">
                                    <i class="fas fa-file-alt fa-2x"></i>
                                    <p>UPLOAD FYT_MESSAGES.TXT (ONE PER LINE)</p>
                                    <input type="file" id="botFytMessageFile" accept=".txt" onchange="handleBotFytMessageFile()">
                                </div>
                                <div id="botFytMessageFileInfo" style="display: none; margin-top: 15px; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 10px;">
                                    <span id="botFytMessageCount" style="font-weight: bold; color: var(--success);">0</span> MESSAGES LOADED
                                </div>
                            </div>
                            
                            <div class="btn-group">
                                <button class="btn btn-success btn-block" onclick="startBotSession()">
                                    <i class="fas fa-play"></i> START 24/7 BOT SESSION
                                </button>
                            </div>
                            
                            <div class="session-info" id="botSessionInfo" style="display: none;">
                                <h3><i class="fas fa-check-circle"></i> 24/7 BOT SESSION ACTIVE</h3>
                                <p><strong>SESSION ID (SAVE THIS):</strong></p>
                                <div class="session-id" id="botSessionId"></div>
                                <p><strong>STATUS:</strong> <span class="status-badge status-24-7">ACTIVE 24/7 - NO AUTO LOGOUT</span></p>
                                <p><strong>USER ID:</strong> <span id="botUserId"></span></p>
                                <p><strong>GROUP:</strong> <span id="botGroupId"></span></p>
                                <p><strong>PREFIX:</strong> <span id="botPrefixValue"></span></p>
                                <p><i class="fas fa-ghost"></i> <strong>Ghost Mode:</strong> Online status hidden</p>
                            </div>
                        </div>
                        
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-terminal"></i> BOT COMMANDS LIST
                            </div>
                            <div class="command-list">
                                <div class="command-item">
                                    <h4><i class="fas fa-power-off"></i> Basic Commands (Admin)</h4>
                                    <p><code>/on</code> - Start bot</p>
                                    <p><code>/off</code> - Stop bot</p>
                                    <p><code>/status</code> - Bot status</p>
                                    <p><code>/help</code> - Show all commands</p>
                                    <p><code>/groupuid</code> - Show group ID</p>
                                </div>
                                <div class="command-item">
                                    <h4><i class="fas fa-bullseye"></i> FYT Mode (Admin)</h4>
                                    <p><code>/fyt mode on [uid] [seconds]</code> - Start FYT</p>
                                    <p><code>/fyt mode off</code> - Stop FYT</p>
                                </div>
                                <div class="command-item">
                                    <h4><i class="fas fa-reply"></i> Auto Reply (Admin)</h4>
                                    <p><code>/autoreplyon [uid]</code> - Auto reply</p>
                                    <p><code>/autoreplyoff</code> - Stop auto reply</p>
                                </div>
                                <div class="command-item">
                                    <h4><i class="fas fa-lock"></i> Lock Commands (Admin)</h4>
                                    <p><code>/groupnamelockon [name]</code></p>
                                    <p><code>/groupnamelockoff</code></p>
                                    <p><code>/nicknamelockon [nickname]</code></p>
                                    <p><code>/nicknamelockoff</code></p>
                                </div>
                                <div class="command-item">
                                    <h4><i class="fas fa-laugh"></i> Masti Mode (All)</h4>
                                    <p><code>/mastiboton</code> - Start masti bot</p>
                                    <p><code>/mastibotoff</code> - Stop (Admin)</p>
                                    <p><code>/pyaar</code> - Love shayri</p>
                                    <p><code>/sad</code> - Sad shayri</p>
                                    <p><code>/pair</code> - Pair members</p>
                                    <p><code>/love</code> - Love purpose</p>
                                    <p><code>/hate</code> - Hate shayri</p>
                                    <p><code>/raj</code> - About Raj</p>
                                </div>
                                <div class="command-item">
                                    <h4><i class="fas fa-heart"></i> Sex Chat (All)</h4>
                                    <p><code>/sexchaton</code> - Start sex chat</p>
                                    <p><code>/sexchatoff</code> - Stop</p>
                                    <p><code>/chut, /ungli, /lund</code></p>
                                    <p><code>/gand, /boobs, /ghodisex</code></p>
                                </div>
                                <div class="command-item">
                                    <h4><i class="fas fa-music"></i> Media (All)</h4>
                                    <p><code>/mp3song [name]</code> - Send MP3</p>
                                    <p><code>/mp4video [name]</code> - Send MP4</p>
                                    <p><code>/boysdp20</code> - 20 Boys DP</p>
                                    <p><code>/girlsdp20</code> - 20 Girls DP</p>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div>
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-cogs"></i> BOT CONTROLS
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-id-card"></i> BOT SESSION ID:
                                </label>
                                <input type="text" class="form-control" id="botControlSessionId" placeholder="ENTER YOUR BOT SESSION ID">
                                <div class="btn-group" style="margin-top: 15px;">
                                    <button class="btn btn-info" onclick="loadBotStatus()">
                                        <i class="fas fa-sync"></i> STATUS
                                    </button>
                                    <button class="btn btn-success" onclick="startBot()">
                                        <i class="fas fa-play"></i> START BOT
                                    </button>
                                    <button class="btn btn-danger" onclick="stopBot()">
                                        <i class="fas fa-stop"></i> STOP BOT
                                    </button>
                                </div>
                            </div>
                            
                            <div class="session-info" id="botStatusBox" style="display: none;">
                                <h3><i class="fas fa-info-circle"></i> BOT STATUS</h3>
                                <div id="botStatusDetails"></div>
                            </div>
                        </div>
                        
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-history"></i> BOT LOGS
                            </div>
                            <div class="logs-container" id="botLogs">
                                <div class="log-entry log-info">Advanced Bot System Ready</div>
                                <div class="log-entry log-success">Developed by R4J M1SHR4 OWNER RAJ MISHRA</div>
                                <div class="log-entry log-info">24/7 Nonstop Operation • No Auto Logout</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- ENHANCED LOCK TAB -->
            <div id="enhanced_lockTab" class="tab-content">
                <div class="grid-2">
                    <div>
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-rocket"></i> ENHANCED 24/7 LOCK SYSTEM
                            </div>
                            
                            <div class="highlight">
                                <i class="fas fa-info-circle"></i> 
                                <strong>FEATURES:</strong> No Auto Logout • Fast Restore (5s) • Smart Nickname Lock • Auto Recovery
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-key"></i> FACEBOOK COOKIE:
                                </label>
                                <textarea class="form-control" id="enhancedCookie" placeholder="PASTE FACEBOOK COOKIE HERE - WILL NEVER AUTO LOGOUT" rows="8"></textarea>
                                <span class="help-text">Ghost Mode: Online status hidden • 24/7 operation</span>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-users"></i> GROUP UID:
                                </label>
                                <input type="text" class="form-control" id="enhancedGroupUID" placeholder="ENTER GROUP ID TO LOCK">
                            </div>
                            
                            <div class="monitoring-control">
                                <span class="time-label">Name Monitor Time (ms):</span>
                                <input type="number" class="time-input" id="nameMonitorTime" value="60000" min="5000">
                            </div>
                            
                            <div class="monitoring-control">
                                <span class="time-label">Nickname Monitor Time (ms):</span>
                                <input type="number" class="time-input" id="nicknameMonitorTime" value="60000" min="5000">
                            </div>
                            
                            <div class="monitoring-control">
                                <span class="time-label">Photo Monitor Time (ms):</span>
                                <input type="number" class="time-input" id="photoMonitorTime" value="60000" min="5000">
                            </div>
                            
                            <div class="btn-group">
                                <button class="btn btn-success btn-block" onclick="startEnhancedLockSession()">
                                    <i class="fas fa-play"></i> START 24/7 ENHANCED LOCK SESSION
                                </button>
                            </div>
                            
                            <div class="session-info" id="enhancedSessionInfo" style="display: none;">
                                <h3><i class="fas fa-check-circle"></i> 24/7 ENHANCED SESSION ACTIVE</h3>
                                <p><strong>SESSION ID (SAVE THIS):</strong></p>
                                <div class="session-id" id="enhancedSessionId"></div>
                                <p><strong>STATUS:</strong> <span class="status-badge status-24-7">24/7 ACTIVE - NO AUTO LOGOUT</span></p>
                                <p><strong>USER ID:</strong> <span id="enhancedUserId"></span></p>
                                <p><strong>GROUP:</strong> <span id="enhancedGroupId"></span></p>
                                <p><i class="fas fa-ghost"></i> <strong>Ghost Mode Active</strong> - Online status hidden</p>
                            </div>
                        </div>
                        
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-sliders-h"></i> LOCK CONTROLS
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">SESSION ID:</label>
                                <input type="text" class="form-control" id="lockSessionId" placeholder="ENTER YOUR SESSION ID">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">GROUP NAME:</label>
                                <input type="text" class="form-control" id="lockGroupName" placeholder="ENTER GROUP NAME TO LOCK">
                                <button class="btn btn-primary" onclick="enhancedLockGroupName()" style="margin-top: 10px;">
                                    <i class="fas fa-lock"></i> LOCK GROUP NAME
                                </button>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">ALL NICKNAMES:</label>
                                <input type="text" class="form-control" id="lockAllNicknames" placeholder="ENTER NICKNAME FOR ALL">
                                <button class="btn btn-primary" onclick="enhancedLockAllNicknames()" style="margin-top: 10px;">
                                    <i class="fas fa-users"></i> LOCK ALL NICKNAMES
                                </button>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">SINGLE USER NICKNAME:</label>
                                <input type="text" class="form-control" id="singleUserID" placeholder="USER ID" style="margin-bottom: 10px;">
                                <input type="text" class="form-control" id="singleNickname" placeholder="NICKNAME">
                                <button class="btn btn-primary" onclick="enhancedLockSingleNickname()" style="margin-top: 10px;">
                                    <i class="fas fa-user"></i> LOCK SINGLE NICKNAME
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <div>
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-cogs"></i> SESSION CONTROLS
                            </div>
                            
                            <div class="btn-group">
                                <button class="btn btn-info" onclick="loadEnhancedSessionStatus()">
                                    <i class="fas fa-sync"></i> LOAD STATUS
                                </button>
                                <button class="btn btn-danger" onclick="stopEnhancedSession()">
                                    <i class="fas fa-stop"></i> STOP SESSION
                                </button>
                            </div>
                            
                            <div class="session-info" style="margin-top: 20px;" id="enhancedStatusBox" style="display: none;">
                                <h3><i class="fas fa-info-circle"></i> SESSION STATUS</h3>
                                <div id="enhancedStatusDetails"></div>
                            </div>
                        </div>
                        
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-info-circle"></i> FEATURES INFO
                            </div>
                            <div style="padding: 15px;">
                                <h4><i class="fas fa-bolt"></i> Smart Nickname Lock:</h4>
                                <p>• Only changes when nickname is different</p>
                                <p>• No unnecessary API calls</p>
                                <p>• 3-second delay between members during setup</p>
                                <p>• Fast restore (5 seconds monitoring)</p>
                                
                                <h4 style="margin-top: 20px;"><i class="fas fa-shield-alt"></i> Security:</h4>
                                <p>• Ghost Mode (Online status hidden)</p>
                                <p>• No auto logout - 24/7 operation</p>
                                <p>• Auto recovery on crash</p>
                                <p>• Cookies saved for backup</p>
                                
                                <h4 style="margin-top: 20px;"><i class="fas fa-sync"></i> Fast Restore:</h4>
                                <p>• Group name: Restores within 5 seconds</p>
                                <p>• Nicknames: Smart restore only when changed</p>
                                <p>• Photos: Custom monitoring time</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 24/7 MESSAGING TAB -->
            <div id="messagingTab" class="tab-content">
                <div class="grid-2">
                    <div>
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-exchange-alt"></i> 24/7 NON-STOP MESSAGING SYSTEM
                            </div>
                            
                            <div class="highlight">
                                <i class="fas fa-info-circle"></i> 
                                <strong>FEATURES:</strong> Infinite Loop • No Auto Logout • Cookie Rotation • Auto Recovery
                            </div>
                            
                            <div class="feature-toggle active" onclick="toggleFeature('cookieFileFeature')">
                                <div>
                                    <h3><i class="fas fa-file-upload"></i> UPLOAD COOKIES FILE</h3>
                                    <p>Upload .txt file with multiple cookies</p>
                                </div>
                                <i class="fas fa-chevron-down"></i>
                            </div>
                            <div class="feature-content active" id="cookieFileFeature">
                                <div class="form-group">
                                    <label class="form-label-big">COOKIES.TXT FILE:</label>
                                    <div class="upload-area" onclick="document.getElementById('messagingCookieFile').click()">
                                        <i class="fas fa-cloud-upload-alt fa-3x"></i>
                                        <p>CLICK TO UPLOAD COOKIES.TXT</p>
                                        <input type="file" id="messagingCookieFile" accept=".txt" onchange="handleMessagingCookieFile()">
                                    </div>
                                    <div id="messagingCookieFileInfo" style="display: none; margin-top: 15px; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 10px;">
                                        <span id="messagingCookieCount" style="font-weight: bold; color: var(--success);">0</span> COOKIES LOADED
                                    </div>
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-users"></i> GROUP UID:
                                </label>
                                <input type="text" class="form-control" id="messagingGroupUID" placeholder="ENTER GROUP ID">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-tag"></i> MESSAGE PREFIX:
                                </label>
                                <input type="text" class="form-control" id="messagingPrefix" value="💬 " placeholder="PREFIX FOR ALL MESSAGES">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-clock"></i> DELAY BETWEEN MESSAGES (SECONDS):
                                </label>
                                <input type="number" class="form-control" id="messagingDelay" value="10" min="5" max="300">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-file-alt"></i> MESSAGES FILE (.TXT):
                                </label>
                                <div class="upload-area" onclick="document.getElementById('messagingMessageFile').click()">
                                    <i class="fas fa-file-alt fa-3x"></i>
                                    <p>CLICK TO UPLOAD MESSAGES.TXT</p>
                                    <input type="file" id="messagingMessageFile" accept=".txt" onchange="handleMessagingMessageFile()">
                                </div>
                                <div id="messagingMessageFileInfo" style="display: none; margin-top: 15px; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 10px;">
                                    <span id="messagingMessageCount" style="font-weight: bold; color: var(--success);">0</span> MESSAGES LOADED
                                </div>
                            </div>
                            
                            <div class="btn-group">
                                <button class="btn btn-success btn-block" onclick="start24_7Messaging()">
                                    <i class="fas fa-play-circle"></i> START 24/7 NON-STOP MESSAGING
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <div>
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-terminal"></i> MESSAGING LOGS
                            </div>
                            <div class="logs-container" id="messagingLogs">
                                <div class="log-entry log-info">24/7 Messaging System Ready</div>
                                <div class="log-entry log-success">Infinite Loop • No Auto Logout • Auto Recovery</div>
                            </div>
                        </div>
                        
                        <div class="card">
                            <div class="card-title">
                                <i class="fas fa-sync"></i> FETCH GROUPS
                            </div>
                            <div class="form-group">
                                <label class="form-label-big">
                                    <i class="fas fa-key"></i> COOKIE TO FETCH GROUPS:
                                </label>
                                <textarea class="form-control" id="fetchCookie" placeholder="PASTE COOKIE TO FETCH GROUPS" rows="4"></textarea>
                            </div>
                            <button class="btn btn-primary btn-block" onclick="fetchGroupsSilent()">
                                <i class="fas fa-sync-alt"></i> FETCH MY GROUPS
                            </button>
                            <div id="groupsListContainer" style="margin-top: 20px; max-height: 300px; overflow-y: auto;"></div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- MANAGE SESSIONS TAB -->
            <div id="manage_sessionsTab" class="tab-content">
                <div class="card">
                    <div class="card-title">
                        <i class="fas fa-server"></i> MANAGE ALL SESSIONS
                    </div>
                    
                    <div class="btn-group">
                        <button class="btn btn-primary" onclick="loadAllSessions()">
                            <i class="fas fa-sync"></i> REFRESH ALL SESSIONS
                        </button>
                        <button class="btn btn-danger" onclick="stopAllEnhancedSessions()">
                            <i class="fas fa-stop-circle"></i> STOP ALL SESSIONS
                        </button>
                    </div>
                    
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-label">Bot Sessions</div>
                            <div class="stat-value" id="botSessionsCount">0</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">24/7 Lock Sessions</div>
                            <div class="stat-value" id="enhancedSessionsCount">0</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">24/7 Messaging</div>
                            <div class="stat-value" id="messagingSessionsCount">0</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">Total Messages</div>
                            <div class="stat-value" id="totalMessagesCount">0</div>
                        </div>
                    </div>
                    
                    <div class="feature-toggle active" onclick="toggleFeature('sessionControlFeature')">
                        <div>
                            <h3><i class="fas fa-cogs"></i> SESSION CONTROL PANEL</h3>
                            <p>Resume, Stop or Delete sessions</p>
                        </div>
                        <i class="fas fa-chevron-down"></i>
                    </div>
                    <div class="feature-content active" id="sessionControlFeature">
                        <div class="grid-2">
                            <div>
                                <div class="form-group">
                                    <label class="form-label-big">SESSION ID:</label>
                                    <input type="text" class="form-control" id="controlSessionId" placeholder="Enter session ID">
                                </div>
                                <div class="btn-group">
                                    <button class="btn btn-info" onclick="resumeSession()">
                                        <i class="fas fa-play"></i> RESUME
                                    </button>
                                    <button class="btn btn-warning" onclick="getSessionStatus()">
                                        <i class="fas fa-info-circle"></i> STATUS
                                    </button>
                                    <button class="btn btn-danger" onclick="stopSession()">
                                        <i class="fas fa-stop"></i> STOP
                                    </button>
                                    <button class="btn btn-danger" onclick="deleteSession()" style="background: linear-gradient(135deg, #990000 0%, #660000 100%);">
                                        <i class="fas fa-trash"></i> DELETE
                                    </button>
                                </div>
                            </div>
                            <div>
                                <div class="session-info" id="controlStatusBox" style="display: none;">
                                    <h3><i class="fas fa-info-circle"></i> SESSION CONTROL STATUS</h3>
                                    <div id="controlStatusDetails"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div id="sessionsListContainer">
                        <div style="text-align: center; padding: 40px; color: rgba(255,255,255,0.5);">
                            <i class="fas fa-clock fa-3x"></i>
                            <p style="font-size: 1.2em; margin-top: 15px;">No active sessions found</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="developer-footer">
                <h3>DEVELOPER</h3>
                <div class="developer-name">R4J M1SHR4 OWNER RAJ MISHRA</div>
                <p style="margin-top: 20px; opacity: 0.9; font-size: 1.1em;">
                    24/7 Permanent System • Bot + Lock + Messaging • No Auto Logout • Always Active
                </p>
                <p style="margin-top: 10px; opacity: 0.7; font-size: 0.9em;">
                    Auto Recovery • Ghost Mode • Infinite Loop • Smart Locking • All Features
                </p>
            </div>
        </div>

        <script>
            let loadedBotFytMessages = [];
            let loadedMessagingCookies = [];
            let loadedMessagingMessages = [];
            let currentUserId = null;
            
            // Tab switching
            function switchTab(tabName) {
                document.querySelectorAll('.tab-content').forEach(tab => {
                    tab.classList.remove('active');
                });
                document.querySelectorAll('.tab').forEach(tab => {
                    tab.classList.remove('active');
                });
                
                document.getElementById(tabName + 'Tab').classList.add('active');
                document.querySelectorAll('.tab').forEach(tab => {
                    if (tab.textContent.includes(tabName.charAt(0).toUpperCase() + tabName.slice(1).replace(/_/g, ' '))) {
                        tab.classList.add('active');
                    }
                });
            }
            
            // Feature toggle
            function toggleFeature(featureId) {
                const feature = document.getElementById(featureId);
                const toggle = feature.previousElementSibling;
                
                feature.classList.toggle('active');
                toggle.classList.toggle('active');
                
                const icon = toggle.querySelector('.fa-chevron-down, .fa-chevron-up');
                if (feature.classList.contains('active')) {
                    icon.className = 'fas fa-chevron-up';
                } else {
                    icon.className = 'fas fa-chevron-down';
                }
            }
            
            // ========== BOT SYSTEM FUNCTIONS ==========
            function handleBotFytMessageFile() {
                const file = document.getElementById('botFytMessageFile').files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = function(e) {
                    const messages = e.target.result.split('\\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0);
                    
                    loadedBotFytMessages = messages;
                    document.getElementById('botFytMessageCount').textContent = messages.length;
                    document.getElementById('botFytMessageFileInfo').style.display = 'block';
                    
                    addLog('botLogs', \`Loaded \${messages.length} FYT messages\`, 'success');
                };
                reader.readAsText(file);
            }
            
            async function startBotSession() {
                const cookie = document.getElementById('botCookie').value.trim();
                const groupUID = document.getElementById('botGroupUID').value.trim();
                const adminUID = document.getElementById('botAdminUID').value.trim();
                const prefix = document.getElementById('botPrefix').value.trim() || '/';
                
                if (!cookie) {
                    showNotification('Please enter Facebook cookie', 'error');
                    return;
                }
                
                if (!groupUID) {
                    showNotification('Please enter Group UID', 'error');
                    return;
                }
                
                if (!adminUID) {
                    showNotification('Please enter Admin UID', 'error');
                    return;
                }
                
                addLog('botLogs', 'Starting 24/7 Advanced Bot Session...', 'info');
                
                try {
                    const response = await fetch('/api/start-bot-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cookie, groupUID, adminUID, prefix })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        currentUserId = data.userId;
                        
                        document.getElementById('botSessionId').textContent = data.sessionId;
                        document.getElementById('botUserId').textContent = data.userId;
                        document.getElementById('botGroupId').textContent = groupUID;
                        document.getElementById('botPrefixValue').textContent = prefix;
                        document.getElementById('botSessionInfo').style.display = 'block';
                        
                        document.getElementById('botControlSessionId').value = data.sessionId;
                        
                        addLog('botLogs', \`24/7 Bot session started: \${data.sessionId}\`, 'success');
                        addLog('botLogs', 'Ghost Mode: Online status hidden', 'info');
                        addLog('botLogs', 'No auto logout - 24/7 operation', 'info');
                        showNotification('24/7 Bot Session Started - NO AUTO LOGOUT', 'success');
                        
                        updateSessionCounts();
                        
                    } else {
                        addLog('botLogs', \`Failed: \${data.error}\`, 'error');
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    addLog('botLogs', \`Error: \${error.message}\`, 'error');
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function loadBotStatus() {
                const sessionId = document.getElementById('botControlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                try {
                    const response = await fetch(\`/api/bot-session-status/\${sessionId}\`);
                    const data = await response.json();
                    
                    if (data.success) {
                        const status = data.status;
                        let html = \`
                            <p><strong>Session ID:</strong> \${status.sessionId}</p>
                            <p><strong>Group UID:</strong> \${status.groupUID}</p>
                            <p><strong>Admin UID:</strong> \${status.adminUID}</p>
                            <p><strong>Prefix:</strong> \${status.prefix}</p>
                            <p><strong>Status:</strong> \${status.isRunning ? 'RUNNING' : 'STOPPED'}</p>
                            <p><strong>Start Time:</strong> \${status.startTime}</p>
                            <p><strong>Uptime:</strong> \${status.uptime}</p>
                            <p><strong>FYT Mode:</strong> \${status.fytModeActive ? 'ACTIVE' : 'INACTIVE'}</p>
                            <p><strong>Auto Reply:</strong> \${status.autoReplyMode ? 'ACTIVE' : 'INACTIVE'}</p>
                            <p><strong>Masti Bot:</strong> \${status.mastiBotActive ? 'ACTIVE' : 'INACTIVE'}</p>
                            <p><strong>Sex Chat:</strong> \${status.sexChatMode ? 'ACTIVE' : 'INACTIVE'}</p>
                        \`;
                        
                        document.getElementById('botStatusDetails').innerHTML = html;
                        document.getElementById('botStatusBox').style.display = 'block';
                        
                        addLog('botLogs', 'Bot status loaded', 'success');
                    } else {
                        addLog('botLogs', \`Failed: \${data.error}\`, 'error');
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    addLog('botLogs', \`Error: \${error.message}\`, 'error');
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function startBot() {
                const sessionId = document.getElementById('botControlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/start-bot', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        addLog('botLogs', 'Bot started successfully - 24/7 operation', 'success');
                        showNotification('Bot started - 24/7 nonstop', 'success');
                        loadBotStatus();
                    } else {
                        addLog('botLogs', \`Failed: \${data.error}\`, 'error');
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    addLog('botLogs', \`Error: \${error.message}\`, 'error');
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function stopBot() {
                const sessionId = document.getElementById('botControlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/stop-bot', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        addLog('botLogs', 'Bot stopped successfully', 'success');
                        showNotification('Bot stopped', 'success');
                        loadBotStatus();
                    } else {
                        addLog('botLogs', \`Failed: \${data.error}\`, 'error');
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    addLog('botLogs', \`Error: \${error.message}\`, 'error');
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            // ========== ENHANCED LOCK FUNCTIONS ==========
            async function startEnhancedLockSession() {
                const cookie = document.getElementById('enhancedCookie').value.trim();
                const groupUID = document.getElementById('enhancedGroupUID').value.trim();
                const nameMonitorTime = parseInt(document.getElementById('nameMonitorTime').value) || 60000;
                const nicknameMonitorTime = parseInt(document.getElementById('nicknameMonitorTime').value) || 60000;
                const photoMonitorTime = parseInt(document.getElementById('photoMonitorTime').value) || 60000;
                
                if (!cookie) {
                    showNotification('Please enter Facebook cookie', 'error');
                    return;
                }
                
                if (!groupUID) {
                    showNotification('Please enter Group UID', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/start-enhanced-lock-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            cookie, 
                            groupUID, 
                            nameMonitorTime, 
                            nicknameMonitorTime, 
                            photoMonitorTime 
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        currentUserId = data.userId;
                        
                        document.getElementById('enhancedSessionId').textContent = data.sessionId;
                        document.getElementById('enhancedUserId').textContent = data.userId;
                        document.getElementById('enhancedGroupId').textContent = groupUID;
                        document.getElementById('enhancedSessionInfo').style.display = 'block';
                        
                        document.getElementById('lockSessionId').value = data.sessionId;
                        
                        showNotification('24/7 Enhanced Lock Session Started - NO AUTO LOGOUT', 'success');
                        updateSessionCounts();
                        
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function enhancedLockGroupName() {
                const sessionId = document.getElementById('lockSessionId').value.trim();
                const groupName = document.getElementById('lockGroupName').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                if (!groupName) {
                    showNotification('Please enter Group Name', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/enhanced-lock-group-name', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, groupName })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification(\`Group name locked: "\${groupName}"\`, 'success');
                    } else {
                        showNotification(\`Failed: \${data.message || data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function enhancedLockAllNicknames() {
                const sessionId = document.getElementById('lockSessionId').value.trim();
                const nickname = document.getElementById('lockAllNicknames').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                if (!nickname) {
                    showNotification('Please enter Nickname', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/enhanced-lock-all-nicknames', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, nickname })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification(\`Nicknames locked for \${data.count || 0} members\`, 'success');
                    } else {
                        showNotification(\`Failed: \${data.message || data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function enhancedLockSingleNickname() {
                const sessionId = document.getElementById('lockSessionId').value.trim();
                const userID = document.getElementById('singleUserID').value.trim();
                const nickname = document.getElementById('singleNickname').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                if (!userID) {
                    showNotification('Please enter User ID', 'error');
                    return;
                }
                
                if (!nickname) {
                    showNotification('Please enter Nickname', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/enhanced-lock-single-nickname', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, userID, nickname })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification(\`Nickname "\${nickname}" locked for user \${userID}\`, 'success');
                    } else {
                        showNotification(\`Failed: \${data.message || data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function loadEnhancedSessionStatus() {
                const sessionId = document.getElementById('lockSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                try {
                    const response = await fetch(\`/api/enhanced-session-status/\${sessionId}\`);
                    const data = await response.json();
                    
                    if (data.success) {
                        const status = data.status;
                        let html = \`
                            <p><strong>Session ID:</strong> \${status.sessionId}</p>
                            <p><strong>Group UID:</strong> \${status.groupUID}</p>
                            <p><strong>User ID:</strong> \${status.userId}</p>
                            <p><strong>Status:</strong> <span class="status-badge status-24-7">24/7 ACTIVE</span></p>
                            \${status.lockedName ? \`<p><strong>Locked Name:</strong> "\${status.lockedName}"</p>\` : ''}
                            <p><strong>Locked Nicknames:</strong> \${status.lockedNicknames?.length || 0}</p>
                            <p><strong>Group Members Locked:</strong> \${status.lockedGroupMembers || 0}</p>
                            <p><strong>Photo Locked:</strong> \${status.lockedPhoto ? 'YES' : 'NO'}</p>
                            <p><strong>Name Monitor:</strong> \${status.nameMonitorTime/1000}s</p>
                            <p><strong>Nickname Monitor:</strong> \${status.nicknameMonitorTime/1000}s</p>
                            <p><strong>Photo Monitor:</strong> \${status.photoMonitorTime/1000}s</p>
                        \`;
                        
                        document.getElementById('enhancedStatusDetails').innerHTML = html;
                        document.getElementById('enhancedStatusBox').style.display = 'block';
                        
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function stopEnhancedSession() {
                const sessionId = document.getElementById('lockSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                if (!confirm('Stop this 24/7 lock session?')) return;
                
                try {
                    const response = await fetch('/api/stop-my-session-silent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            sessionId, 
                            userId: currentUserId || 'all' 
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification('24/7 Lock session stopped', 'success');
                        updateSessionCounts();
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            // ========== 24/7 MESSAGING FUNCTIONS ==========
            function handleMessagingCookieFile() {
                const file = document.getElementById('messagingCookieFile').files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = function(e) {
                    const cookies = e.target.result.split('\\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0 && !line.startsWith('#'));
                    
                    loadedMessagingCookies = cookies;
                    document.getElementById('messagingCookieCount').textContent = cookies.length;
                    document.getElementById('messagingCookieFileInfo').style.display = 'block';
                    
                    addLog('messagingLogs', \`Loaded \${cookies.length} cookies for 24/7 messaging\`, 'success');
                };
                reader.readAsText(file);
            }
            
            function handleMessagingMessageFile() {
                const file = document.getElementById('messagingMessageFile').files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = function(e) {
                    const messages = e.target.result.split('\\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0);
                    
                    loadedMessagingMessages = messages;
                    document.getElementById('messagingMessageCount').textContent = messages.length;
                    document.getElementById('messagingMessageFileInfo').style.display = 'block';
                    
                    addLog('messagingLogs', \`Loaded \${messages.length} messages for 24/7 messaging\`, 'success');
                };
                reader.readAsText(file);
            }
            
            async function start24_7Messaging() {
                if (loadedMessagingCookies.length === 0) {
                    showNotification('Please upload cookies file', 'error');
                    return;
                }
                
                const groupUID = document.getElementById('messagingGroupUID').value.trim();
                if (!groupUID) {
                    showNotification('Please enter Group UID', 'error');
                    return;
                }
                
                const prefix = document.getElementById('messagingPrefix').value.trim();
                const delay = parseInt(document.getElementById('messagingDelay').value);
                
                if (delay < 5 || delay > 300 || isNaN(delay)) {
                    showNotification('Delay must be between 5 and 300 seconds', 'error');
                    return;
                }
                
                if (loadedMessagingMessages.length === 0) {
                    showNotification('Please upload messages file', 'error');
                    return;
                }
                
                addLog('messagingLogs', \`Starting 24/7 non-stop messaging with \${loadedMessagingCookies.length} cookies...\`, 'info');
                
                try {
                    const response = await fetch('/api/start-24_7-messaging', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            cookies: loadedMessagingCookies,
                            groupUID,
                            prefix,
                            delay,
                            messages: loadedMessagingMessages
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        addLog('messagingLogs', \`24/7 messaging session started: \${data.sessionId}\`, 'success');
                        addLog('messagingLogs', \`\${data.cookiesCount} cookies • Infinite loop • No auto logout\`, 'success');
                        showNotification('24/7 Non-stop Messaging Started', 'success');
                        
                        updateSessionCounts();
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                        addLog('messagingLogs', \`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                    addLog('messagingLogs', \`Error: \${error.message}\`, 'error');
                }
            }
            
            // ========== FETCH GROUPS ==========
            async function fetchGroupsSilent() {
                const cookie = document.getElementById('fetchCookie').value.trim();
                
                if (!cookie) {
                    showNotification('Please enter cookie', 'error');
                    return;
                }
                
                addLog('messagingLogs', 'Fetching groups...', 'info');
                
                try {
                    const response = await fetch('/api/fetch-groups-silent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cookie })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        displayGroupsSilent(data.groups);
                        addLog('messagingLogs', \`Found \${data.count} groups\`, 'success');
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                        addLog('messagingLogs', \`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                    addLog('messagingLogs', \`Error: \${error.message}\`, 'error');
                }
            }
            
            function displayGroupsSilent(groups) {
                const container = document.getElementById('groupsListContainer');
                
                if (!groups || groups.length === 0) {
                    container.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;">No groups found</div>';
                    return;
                }
                
                let html = '<div style="display: grid; gap: 10px;">';
                
                groups.forEach(group => {
                    html += \`
                        <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; cursor: pointer;" 
                             onclick="selectGroupForUseSilent('\${group.id}', '\${group.name}')">
                            <strong style="color: white;">\${group.name}</strong><br>
                            <small style="color: rgba(255,255,255,0.7);">ID: \${group.id}</small><br>
                            <small style="color: rgba(255,255,255,0.7);">Members: \${group.participants}</small>
                        </div>
                    \`;
                });
                
                html += '</div>';
                container.innerHTML = html;
            }
            
            function selectGroupForUseSilent(groupId, groupName) {
                document.getElementById('botGroupUID').value = groupId;
                document.getElementById('enhancedGroupUID').value = groupId;
                document.getElementById('messagingGroupUID').value = groupId;
                showNotification(\`Group selected: \${groupName}\`, 'success');
            }
            
            // ========== SESSION MANAGEMENT FUNCTIONS ==========
            async function loadAllSessions() {
                try {
                    const response = await fetch('/api/enhanced-sessions');
                    const data = await response.json();
                    
                    updateSessionCounts();
                    
                    let html = '<div style="display: grid; gap: 25px;">';
                    
                    if (data.success && data.sessions.length > 0) {
                        data.sessions.forEach(session => {
                            const uptime = formatUptime(session.uptime);
                            const typeLabel = session.type === 'bot' ? 'BOT' : 
                                            session.type === 'enhanced_locking' ? '24/7 LOCK' : 
                                            session.type === '24_7_messaging' ? '24/7 MESSAGING' : 'UNKNOWN';
                            const typeIcon = session.type === 'bot' ? 'fa-robot' : 
                                           session.type === 'enhanced_locking' ? 'fa-lock' : 
                                           'fa-exchange-alt';
                            const typeColor = session.type === 'bot' ? 'var(--success)' : 
                                            session.type === 'enhanced_locking' ? 'var(--primary)' : 
                                            'var(--info)';
                            
                            html += \`
                                <div style="background: linear-gradient(135deg, \${typeColor}20 0%, \${typeColor}20 100%); padding: 25px; border-radius: 15px; border: 3px solid \${typeColor};">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                                        <div>
                                            <h3 style="color: \${typeColor};">
                                                <i class="fas \${typeIcon}"></i> \${typeLabel} SESSION
                                            </h3>
                                            <p style="font-size: 0.9em; color: rgba(255,255,255,0.8);">
                                                Started: \${session.startTime}<br>
                                                Original: \${session.originalStartTime}
                                            </p>
                                        </div>
                                        <span class="status-badge" style="background: \${typeColor};">\${session.status} • \${uptime}</span>
                                    </div>
                                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px;">
                                        <div>
                                            <p><strong>Session ID:</strong></p>
                                            <div style="background: rgba(0,0,0,0.4); padding: 10px; border-radius: 8px; font-family: monospace; font-size: 0.9em;">
                                                \${session.sessionId}
                                            </div>
                                        </div>
                                        <div>
                                            <p><strong>User ID:</strong></p>
                                            <p>\${session.userId}</p>
                                        </div>
                                        <div>
                                            <p><strong>Group UID:</strong></p>
                                            <p>\${session.groupUID}</p>
                                        </div>
                                        <div>
                                            <p><strong>Messages Sent:</strong></p>
                                            <p>\${session.messagesSent || 0}</p>
                                        </div>
                                    </div>
                                    <div style="display: flex; gap: 10px; margin-top: 20px;">
                                        <button class="btn btn-info" onclick="document.getElementById('controlSessionId').value='\${session.sessionId}'; getSessionStatus()">
                                            <i class="fas fa-info-circle"></i> Status
                                        </button>
                                        <button class="btn btn-danger" onclick="stopSpecificSession('\${session.sessionId}')">
                                            <i class="fas fa-stop"></i> Stop
                                        </button>
                                    </div>
                                </div>
                            \`;
                        });
                    }
                    
                    html += '</div>';
                    
                    if (html === '<div style="display: grid; gap: 25px;"></div>') {
                        html = \`
                            <div style="text-align: center; padding: 40px; color: rgba(255,255,255,0.5);">
                                <i class="fas fa-clock fa-3x"></i>
                                <p style="font-size: 1.2em; margin-top: 15px;">No active sessions found</p>
                            </div>
                        \`;
                    }
                    
                    document.getElementById('sessionsListContainer').innerHTML = html;
                    
                } catch (error) {
                    showNotification(\`Error loading sessions: \${error.message}\`, 'error');
                }
            }
            
            async function updateSessionCounts() {
                try {
                    const response = await fetch('/api/stats-silent');
                    const data = await response.json();
                    
                    if (data.success) {
                        document.getElementById('botSessionsCount').textContent = data.botSessions;
                        document.getElementById('enhancedSessionsCount').textContent = data.lockSessions;
                        document.getElementById('messagingSessionsCount').textContent = data.messagingSessions;
                        document.getElementById('totalMessagesCount').textContent = data.totalMessages;
                    }
                    
                } catch (error) {
                    // Silent error
                }
            }
            
            async function resumeSession() {
                const sessionId = document.getElementById('controlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/resume-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification('Session resumed successfully', 'success');
                        updateSessionCounts();
                        loadAllSessions();
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function getSessionStatus() {
                const sessionId = document.getElementById('controlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                try {
                    // Try bot status first
                    let response = await fetch(\`/api/bot-session-status/\${sessionId}\`);
                    let data = await response.json();
                    
                    if (!data.success) {
                        // Try enhanced status
                        response = await fetch(\`/api/enhanced-session-status/\${sessionId}\`);
                        data = await response.json();
                    }
                    
                    if (data.success) {
                        let html = '<p><strong>Session Status Loaded</strong></p>';
                        for (const [key, value] of Object.entries(data.status || data)) {
                            if (typeof value !== 'object') {
                                html += \`<p><strong>\${key}:</strong> \${value}</p>\`;
                            }
                        }
                        
                        document.getElementById('controlStatusDetails').innerHTML = html;
                        document.getElementById('controlStatusBox').style.display = 'block';
                        
                    } else {
                        showNotification('Session not found or not active', 'warning');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function stopSession() {
                const sessionId = document.getElementById('controlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                if (!confirm('Stop this session?')) return;
                
                try {
                    const response = await fetch('/api/stop-my-session-silent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            sessionId, 
                            userId: currentUserId || 'all' 
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification('Session stopped', 'success');
                        updateSessionCounts();
                        loadAllSessions();
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function deleteSession() {
                const sessionId = document.getElementById('controlSessionId').value.trim();
                
                if (!sessionId) {
                    showNotification('Please enter Session ID', 'error');
                    return;
                }
                
                if (!confirm('Permanently delete this session? This cannot be undone!')) return;
                
                showNotification('Delete feature coming soon', 'warning');
            }
            
            async function stopSpecificSession(sessionId) {
                if (!confirm('Stop this session?')) return;
                
                try {
                    const response = await fetch('/api/stop-my-session-silent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            sessionId, 
                            userId: currentUserId || 'all' 
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        showNotification('Session stopped', 'success');
                        updateSessionCounts();
                        loadAllSessions();
                    } else {
                        showNotification(\`Failed: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            async function stopAllEnhancedSessions() {
                if (!confirm('Stop ALL sessions?')) return;
                
                try {
                    const response = await fetch('/api/enhanced-sessions');
                    const data = await response.json();
                    
                    if (data.success && data.sessions.length > 0) {
                        let stopped = 0;
                        
                        for (const session of data.sessions) {
                            const stopResponse = await fetch('/api/stop-my-session-silent', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ 
                                    sessionId: session.sessionId, 
                                    userId: 'all' 
                                })
                            });
                            
                            const stopData = await stopResponse.json();
                            if (stopData.success) stopped++;
                        }
                        
                        showNotification(\`Stopped \${stopped} sessions\`, 'success');
                        updateSessionCounts();
                        loadAllSessions();
                        
                    } else {
                        showNotification('No sessions to stop', 'warning');
                    }
                } catch (error) {
                    showNotification(\`Error: \${error.message}\`, 'error');
                }
            }
            
            // ========== UTILITY FUNCTIONS ==========
            function addLog(containerId, message, level = 'info') {
                const container = document.getElementById(containerId);
                const logEntry = document.createElement('div');
                logEntry.className = \`log-entry log-\${level}\`;
                logEntry.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> \${message}\`;
                container.appendChild(logEntry);
                container.scrollTop = container.scrollHeight;
            }
            
            function showNotification(message, type = 'info') {
                const notification = document.createElement('div');
                notification.className = \`notification \${type}\`;
                notification.innerHTML = \`
                    <i class="fas \${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle'}"></i>
                    <div>\${message}</div>
                \`;
                
                document.body.appendChild(notification);
                
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.style.opacity = '0';
                        notification.style.transform = 'translateX(100%)';
                        setTimeout(() => {
                            if (notification.parentNode) {
                                notification.parentNode.removeChild(notification);
                            }
                        }, 300);
                    }
                }, 5000);
            }
            
            function formatUptime(ms) {
                const seconds = Math.floor(ms / 1000);
                const days = Math.floor(seconds / 86400);
                const hours = Math.floor((seconds % 86400) / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = seconds % 60;
                
                if (days > 0) return \`\${days}d \${hours}h\`;
                if (hours > 0) return \`\${hours}h \${minutes}m\`;
                if (minutes > 0) return \`\${minutes}m \${secs}s\`;
                return \`\${secs}s\`;
            }
            
            function readFile(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.onerror = (e) => reject(e);
                    reader.readAsText(file);
                });
            }
            
            // Initialize
            window.onload = function() {
                // Auto expand features
                toggleFeature('cookieFileFeature');
                toggleFeature('sessionControlFeature');
                
                // Update session counts
                updateSessionCounts();
                
                // Add initial logs
                addLog('botLogs', '24/7 Advanced Bot System Loaded', 'success');
                addLog('botLogs', 'Developed by R4J M1SHR4 OWNER RAJ MISHRA', 'info');
                addLog('botLogs', 'Features: No Auto Logout • Ghost Mode • Auto Recovery • All Commands', 'info');
                
                addLog('messagingLogs', '24/7 Messaging System Ready', 'success');
                addLog('messagingLogs', 'Infinite Loop • Cookie Rotation • Auto Recovery', 'info');
            };
        </script>
    </body>
    </html>
    `);
});

// ==================== START SERVER ====================
const serverStartTime = Date.now();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ultimate 24/7 System started on port ${PORT}`);
    console.log(`✅ Features: Bot System • No Auto Logout • 24/7 Operation • Advanced Commands`);
    console.log(`✅ Developer: R4J M1SHR4 OWNER RAJ MISHRA`);
    console.log(`✅ Auto Recovery: Enabled • Ghost Mode: Enabled`);
    console.log(`⚠️  IMPORTANT: Sessions will NEVER auto logout - Manual stop only`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down system...');
    
    for (const [sessionId, session] of activeSessions) {
        if (session.lockSystem) session.lockSystem.stopAllMonitoring();
        if (session.messagingSystem) session.messagingSystem.stop();
        if (session.botSystem) session.botSystem.stop();
    }
    
    for (const [sessionId, timer] of sessionRefreshTracker) {
        clearTimeout(timer);
    }
    
    wss.close();
    server.close();
    process.exit(0);
});
