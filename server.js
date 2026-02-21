const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- DATA STORE ---
let playerSpots = 20;
let players = []; 
let waitlist = [];
const ADMIN_PASSWORD = "964888";

// Game details - SUNDAY HOCKEY
let gameLocation = "WFCU Greenshield";
let gameTime = "Sunday 8:30 PM";
let gameDate = "";

// Player signup password protection
let playerSignupCode = generateRandomCode();
let requirePlayerCode = true;
let manualOverride = false;
let manualOverrideState = null; // 'locked' or 'open' - persists until next auto event

// Store admin sessions
let adminSessions = {};

// Weekly reset tracking
let lastResetWeek = null;
let rosterReleased = false;
let currentWeekData = {
    weekNumber: null,
    year: null,
    releaseDate: null,
    whiteTeam: [],
    darkTeam: []
};

const MAX_GOALIES = 2;

const GAME_RULES = [
    "No Contact, may tie up player along board plays.",
    "Keep negative comments to yourself.",
    "Pass the puck!",
    "Don't stick handle around everyone each and every shift. Don't be a hotdog.",
    "Shift OFF often.",
    "No slashing period., lift the bloody stick. If you slash, intentional or not and hurt the opposing player. You are done for the night and future infraction will end in being Banned period.",
    "Skate hard, shift off when you're huffing and puffing.",
    "Don't need to be overly aggressive, tone down the aggression. If pickup hockey.",
    "Slap shots, don't take it if you can't control it. If you hit goalies in the head, or hurt anyone, you are banned from taking slapshots.",
    "Have fun!"
];

// --- FIXED TIME FUNCTIONS ---

function getCurrentETTime() {
    // Get current time in ET timezone properly
    const now = new Date();
    
    // Convert to ET timezone string
    const etString = now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    // Parse the ET string into components
    const [datePart, timePart] = etString.split(', ');
    const [month, day, year] = datePart.split('/').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    
    // Create date object from ET components (treat as local for comparison)
    const etDate = new Date(year, month - 1, day, hour, minute, second);
    
    return etDate;
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return {
        week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7),
        year: d.getUTCFullYear()
    };
}

// --- NEW SUNDAY SCHEDULE: Lock schedule with manual override support ---
// LOCKED: Monday 12:00 AM (00:00) → Wednesday 6:00 PM (18:00) ET
// OPEN: Wednesday 6:00 PM (18:00) → Sunday 12:00 PM (12:00) ET
// ROSTER RELEASE: Sunday 12:00 PM (12:00) ET - then locks until Monday 12:00 AM reset
function shouldBeLocked() {
    const etTime = getCurrentETTime();
    const day = etTime.getDay(); // 0 = Sunday, 1 = Monday, 3 = Wednesday
    const hour = etTime.getHours();
    
    console.log(`[AUTO-LOCK CHECK] ET Time: ${etTime.toLocaleString('en-US', {weekday: 'short', hour: '2-digit', minute: '2-digit'})}, Day: ${day}, Hour: ${hour}`);
    
    // Monday (1) 12:00 AM (00:00) through Wednesday (3) before 6:00 PM (18:00) = LOCKED
    if (day === 1) {
        // Monday all day (from 12am) - LOCKED
        console.log('[AUTO-LOCK] Monday - SHOULD LOCK');
        return true;
    }
    if (day === 2) {
        // Tuesday all day - LOCKED
        console.log('[AUTO-LOCK] Tuesday - SHOULD LOCK');
        return true;
    }
    if (day === 3 && hour < 18) {
        // Wednesday before 6:00 PM - LOCKED
        console.log('[AUTO-LOCK] Wednesday before 6pm - SHOULD LOCK');
        return true;
    }
    
    // If roster was released (Sunday 12pm), lock from Sunday 12pm until Monday 12am
    if (rosterReleased && day === 0 && hour >= 12) {
        console.log('[AUTO-LOCK] Roster released - Sunday after 12pm - SHOULD LOCK');
        return true;
    }
    
    // All other times = OPEN (Wednesday 6pm to Sunday 12pm, before roster release)
    console.log('[AUTO-LOCK] Outside lock window - SHOULD OPEN');
    return false;
}

// FIXED: Enhanced checkAutoLock with manual override support
function checkAutoLock() {
    console.log('[AUTO-LOCK] Running check at:', new Date().toISOString());
    
    const etTime = getCurrentETTime();
    const day = etTime.getDay();
    const hour = etTime.getHours();
    
    // If roster was released, ensure we stay locked until Monday 12am
    if (rosterReleased) {
        // Keep locked from Sunday 12pm through Monday 12am
        if ((day === 0 && hour >= 12) || day === 1) {
            // Check if manual override wants to open (only allow if not in critical lock period)
            if (manualOverride && manualOverrideState === 'open') {
                console.log('[AUTO-LOCK] Manual override to OPEN during roster lock - RESPECTING OVERRIDE');
                if (requirePlayerCode) {
                    requirePlayerCode = false;
                    saveData();
                }
                return { 
                    requirePlayerCode: false, 
                    manualOverride: true, 
                    manualOverrideState: manualOverrideState,
                    isLockedWindow: true,
                    rosterReleased: true 
                };
            }
            
            if (!requirePlayerCode) {
                console.log('[AUTO-LOCK] Roster released - forcing lock');
                requirePlayerCode = true;
                manualOverride = false;
                manualOverrideState = null;
                saveData();
            }
            return { 
                requirePlayerCode: true, 
                manualOverride: false, 
                manualOverrideState: null,
                isLockedWindow: true,
                rosterReleased: true 
            };
        }
    }
    
    const shouldLock = shouldBeLocked();
    
    // Handle manual override - admin has manually set a state
    if (manualOverride && manualOverrideState) {
        console.log(`[AUTO-LOCK] Manual override active: ${manualOverrideState}`);
        
        if (manualOverrideState === 'locked') {
            if (!requirePlayerCode) {
                requirePlayerCode = true;
                saveData();
            }
            return { 
                requirePlayerCode: true, 
                manualOverride: true, 
                manualOverrideState: 'locked',
                isLockedWindow: shouldLock,
                rosterReleased 
            };
        } else if (manualOverrideState === 'open') {
            if (requirePlayerCode) {
                requirePlayerCode = false;
                saveData();
            }
            return { 
                requirePlayerCode: false, 
                manualOverride: true, 
                manualOverrideState: 'open',
                isLockedWindow: shouldLock,
                rosterReleased 
            };
        }
    }
    
    // Auto-schedule logic (no manual override)
    if (shouldLock) {
        if (!requirePlayerCode) {
            requirePlayerCode = true;
            console.log("[AUTO-LOCK] 🔒 LOCKED by schedule");
            saveData();
        }
    } else {
        if (requirePlayerCode) {
            requirePlayerCode = false;
            console.log("[AUTO-LOCK] ✅ OPEN by schedule (Wednesday 6pm ET)");
            saveData();
        }
    }
    
    return { 
        requirePlayerCode, 
        manualOverride: false, 
        manualOverrideState: null,
        isLockedWindow: shouldLock,
        rosterReleased 
    };
}

// --- FIXED: AUTO ROSTER RELEASE FUNCTION - SUNDAY 12:00 PM ---
async function autoReleaseRoster() {
    console.log('[AUTO-RELEASE] Checking conditions...');
    
    const etTime = getCurrentETTime();
    const day = etTime.getDay();    // 0 = Sunday
    const hour = etTime.getHours(); // 12 = 12pm
    const minute = etTime.getMinutes();
    
    // Only release on Sunday at 12:00 PM (12:00) if not already released and players exist
    if (day === 0 && hour === 12 && minute === 0 && !rosterReleased && players.length > 0) {
        console.log('[AUTO-RELEASE] 🏒 Sunday 12:00 PM ET - Auto-releasing roster!');
        
        try {
            const { week, year } = getWeekNumber(etTime);
            
            console.log('[AUTO-RELEASE] Generating balanced teams...');
            const teams = generateFairTeams();
            
            // Mark as released
            rosterReleased = true;
            
            // LOCK SIGNUP IMMEDIATELY after auto-release
            requirePlayerCode = true;
            manualOverride = false;
            manualOverrideState = null;
            console.log('[AUTO-RELEASE] 🔒 Signup LOCKED after auto roster release');
            
            currentWeekData = {
                weekNumber: week,
                year: year,
                releaseDate: new Date().toISOString(),
                whiteTeam: teams.whiteTeam,
                darkTeam: teams.darkTeam
            };
            
            // Save team assignments to database
            for (const player of players) {
                await pool.query('UPDATE players SET team = $1 WHERE id = $2', [player.team, player.id]);
            }
            
            // Save to history
            await saveWeekHistory(year, week, teams.whiteTeam, teams.darkTeam);
            await saveData();
            
            console.log(`[AUTO-RELEASE] ✅ Success! White: ${teams.whiteTeam.length}, Dark: ${teams.darkTeam.length}`);
            
        } catch (error) {
            console.error('[AUTO-RELEASE] ❌ Error:', error);
        }
    } else {
        if (rosterReleased) {
            console.log('[AUTO-RELEASE] Already released this week');
        } else if (players.length === 0) {
            console.log('[AUTO-RELEASE] No players registered');
        } else {
            console.log(`[AUTO-RELEASE] Not Sunday 12:00 PM (Day: ${day}, Hour: ${hour}, Min: ${minute})`);
        }
    }
}

// --- MODIFIED: Weekly Reset at Monday 12:00 AM (midnight) ET ---
// Signup stays LOCKED after reset until Wednesday 6pm (unless manually overridden)
function checkWeeklyReset() {
    const etTime = getCurrentETTime();
    const { week: currentWeek, year: currentYear } = getWeekNumber(etTime);
    const day = etTime.getDay(); // 1 = Monday
    const hour = etTime.getHours(); // 0 = 12am
    
    // Reset at Monday 12:00 AM (00:00) - day 1, hour 0
    if (day === 1 && hour === 0 && (lastResetWeek !== currentWeek || currentWeekData.year !== currentYear)) {
        console.log(`[WEEKLY RESET] 🕛 Monday 12:00 AM ET - Resetting for week ${currentWeek}, ${currentYear}`);
        
        // Save current week to history if roster was released
        if (rosterReleased && currentWeekData.weekNumber && 
            (currentWeekData.whiteTeam.length > 0 || currentWeekData.darkTeam.length > 0)) {
            saveWeekHistory(
                currentWeekData.year,
                currentWeekData.weekNumber,
                currentWeekData.whiteTeam,
                currentWeekData.darkTeam
            );
        }
        
        // Reset all game data
        playerSpots = 20;
        players = []; 
        waitlist = [];
        rosterReleased = false;
        lastResetWeek = currentWeek;
        gameDate = calculateNextSunday();
        
        // IMPORTANT: Keep existing signup code - DO NOT generate new one
        // playerSignupCode stays the same!
        
        currentWeekData = {
            weekNumber: currentWeek,
            year: currentYear,
            releaseDate: null,
            whiteTeam: [],
            darkTeam: []
        };
        
        // CRITICAL: Signup stays LOCKED after reset until Wednesday 6pm (unless manually overridden)
        // Clear any previous manual override from last week
        manualOverride = false;
        manualOverrideState = null;
        requirePlayerCode = true;
        
        saveData();
        console.log("[WEEKLY RESET] ✅ New week started - registration reset, signup LOCKED until Wednesday 6pm, code kept: " + playerSignupCode);
    }
}

// FIXED: More frequent checks (5 seconds) for testing, 30 seconds for production
const CHECK_INTERVAL = process.env.NODE_ENV === 'production' ? 30000 : 5000;

setInterval(() => {
    checkAutoLock();
    checkWeeklyReset();
    saveData();
}, CHECK_INTERVAL);

// --- DATABASE FUNCTIONS ---

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value JSONB NOT NULL
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                paid BOOLEAN DEFAULT false,
                rating INTEGER NOT NULL,
                is_goalie BOOLEAN DEFAULT false,
                team VARCHAR(10),
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                rules_agreed BOOLEAN DEFAULT false
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS waitlist (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                rating INTEGER NOT NULL,
                is_goalie BOOLEAN DEFAULT false,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS history (
                id SERIAL PRIMARY KEY,
                week_number INTEGER NOT NULL,
                year INTEGER NOT NULL,
                release_date TIMESTAMP NOT NULL,
                game_location VARCHAR(200),
                game_time VARCHAR(50),
                game_date DATE,
                white_team JSONB,
                dark_team JSONB,
                white_avg NUMERIC(3,1),
                dark_avg NUMERIC(3,1)
            )
        `);
        
        console.log('Database initialized successfully');
        await loadDataFromDB();
    } catch (err) {
        console.error('Database initialization error:', err);
        loadDataFromFile();
    }
}

async function loadDataFromDB() {
    try {
        const settingsRes = await pool.query('SELECT * FROM settings');
        const settings = {};
        settingsRes.rows.forEach(row => {
            settings[row.key] = row.value;
        });
        
        if (settings.playerSpots) playerSpots = settings.playerSpots;
        if (settings.gameLocation) gameLocation = settings.gameLocation;
        if (settings.gameTime) gameTime = settings.gameTime;
        if (settings.gameDate) gameDate = settings.gameDate;
        if (settings.playerSignupCode) playerSignupCode = settings.playerSignupCode;
        if (settings.requirePlayerCode !== undefined) requirePlayerCode = settings.requirePlayerCode;
        if (settings.manualOverride !== undefined) manualOverride = settings.manualOverride;
        if (settings.manualOverrideState !== undefined) manualOverrideState = settings.manualOverrideState;
        if (settings.lastResetWeek) lastResetWeek = settings.lastResetWeek;
        if (settings.rosterReleased !== undefined) rosterReleased = settings.rosterReleased;
        if (settings.currentWeekData) currentWeekData = settings.currentWeekData;
        
        const playersRes = await pool.query('SELECT * FROM players ORDER BY registered_at');
        players = playersRes.rows.map(p => ({
            id: p.id,
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            paid: p.paid,
            rating: p.rating,
            isGoalie: p.is_goalie,
            team: p.team,
            registeredAt: p.registered_at,
            rulesAgreed: p.rules_agreed
        }));
        
        const waitlistRes = await pool.query('SELECT * FROM waitlist ORDER BY joined_at');
        waitlist = waitlistRes.rows.map(p => ({
            id: p.id,
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            rating: p.rating,
            isGoalie: p.is_goalie,
            joinedAt: p.joined_at
        }));
        
        console.log(`Loaded from DB: ${players.length} players, ${waitlist.length} waitlist`);
    } catch (err) {
        console.error('Error loading from DB:', err);
        throw err;
    }
}

async function saveSetting(key, value) {
    try {
        await pool.query(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, JSON.stringify(value)]
        );
    } catch (err) {
        console.error('Error saving setting:', err);
    }
}

async function saveData() {
    try {
        await saveSetting('playerSpots', playerSpots);
        await saveSetting('gameLocation', gameLocation);
        await saveSetting('gameTime', gameTime);
        await saveSetting('gameDate', gameDate);
        await saveSetting('playerSignupCode', playerSignupCode);
        await saveSetting('requirePlayerCode', requirePlayerCode);
        await saveSetting('manualOverride', manualOverride);
        await saveSetting('manualOverrideState', manualOverrideState);
        await saveSetting('lastResetWeek', lastResetWeek);
        await saveSetting('rosterReleased', rosterReleased);
        await saveSetting('currentWeekData', currentWeekData);
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

// --- FALLBACK FILE FUNCTIONS ---
const DATA_FILE = './data.json';

function generateRandomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function loadDataFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            playerSpots = data.playerSpots ?? 20;
            players = data.players ?? [];
            waitlist = data.waitlist ?? [];
            gameLocation = data.gameLocation ?? "WFCU Greenshield";
            gameTime = data.gameTime ?? "Sunday 8:30 PM";
            gameDate = data.gameDate ?? calculateNextSunday();
            playerSignupCode = data.playerSignupCode ?? generateRandomCode();
            requirePlayerCode = data.requirePlayerCode ?? true;
            manualOverride = data.manualOverride ?? false;
            manualOverrideState = data.manualOverrideState ?? null;
            lastResetWeek = data.lastResetWeek ?? null;
            rosterReleased = data.rosterReleased ?? false;
            currentWeekData = data.currentWeekData ?? {
                weekNumber: null,
                year: null,
                releaseDate: null,
                whiteTeam: [],
                darkTeam: []
            };
            console.log('Data loaded from file (fallback)');
        } else {
            gameDate = calculateNextSunday();
            console.log('New signup code generated:', playerSignupCode);
        }
    } catch (err) {
        console.error('Error loading data:', err);
        gameDate = calculateNextSunday();
    }
}

function saveDataToFile() {
    try {
        const data = {
            playerSpots,
            players,
            waitlist,
            gameLocation,
            gameTime,
            gameDate,
            playerSignupCode,
            requirePlayerCode,
            manualOverride,
            manualOverrideState,
            lastResetWeek,
            rosterReleased,
            currentWeekData
        };
        const tmpFile = DATA_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        fs.renameSync(tmpFile, DATA_FILE);
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

// Calculate next Sunday
function calculateNextSunday() {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Sunday
    const daysUntilSunday = (7 - dayOfWeek) % 7;
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilSunday);
    return nextSunday.toISOString().split('T')[0];
}

function formatGameDate(dateString) {
    if (!dateString) return "TBD";
    const date = new Date(dateString + 'T00:00:00');
    const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// --- HELPER FUNCTIONS ---

function validatePhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length === 10;
}

function formatPhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (match) {
        return '(' + match[1] + ') ' + match[2] + '-' + match[3];
    }
    return phone;
}

function isDuplicatePlayer(firstName, lastName, phone) {
    const normalizedName = (firstName + ' ' + lastName).toLowerCase().trim();
    const normalizedPhone = phone.replace(/\D/g, '');
    
    const inPlayers = players.find(p => 
        (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
        p.phone.replace(/\D/g, '') === normalizedPhone
    );
    
    const inWaitlist = waitlist.find(p => 
        (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
        p.phone.replace(/\D/g, '') === normalizedPhone
    );
    
    return inPlayers || inWaitlist;
}

function getPlayerCount() {
    return players.filter(p => !p.isGoalie).length;
}

function getGoalieCount() {
    return players.filter(p => p.isGoalie).length;
}

function isGoalieSpotsAvailable() {
    return getGoalieCount() < MAX_GOALIES;
}

// --- MODIFIED: Generate teams with alphabetical ordering by first name ---
function generateFairTeams() {
    console.log('Generating teams from players:', players.length);
    
    // Separate goalies and skaters
    const goalies = players.filter(p => p.isGoalie);
    const skaters = players.filter(p => !p.isGoalie);
    
    // Sort skaters alphabetically by first name, then last name
    skaters.sort((a, b) => {
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    // Sort goalies alphabetically by first name too
    goalies.sort((a, b) => {
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    let whiteTeam = [];
    let darkTeam = [];
    let whiteRating = 0;
    let darkRating = 0;
    
    // Distribute goalies first - one to each team if 2+ goalies
    if (goalies.length >= 2) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        darkTeam.push({ ...goalies[1], team: 'Dark' });
        whiteRating += parseInt(goalies[0].rating) || 0;
        darkRating += parseInt(goalies[1].rating) || 0;
    } else if (goalies.length === 1) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        whiteRating += parseInt(goalies[0].rating) || 0;
    }
    
    // Distribute skaters in snake draft order for balance
    // But maintain alphabetical listing in the final display
    let whiteTurn = whiteTeam.length <= darkTeam.length;
    
    for (let i = 0; i < skaters.length; i++) {
        const skater = skaters[i];
        
        if (whiteTurn) {
            whiteTeam.push({ ...skater, team: 'White' });
            whiteRating += parseInt(skater.rating) || 0;
        } else {
            darkTeam.push({ ...skater, team: 'Dark' });
            darkRating += parseInt(skater.rating) || 0;
        }
        
        whiteTurn = !whiteTurn;
        
        // Balance team sizes
        if (Math.abs(whiteTeam.length - darkTeam.length) > 1) {
            whiteTurn = whiteTeam.length < darkTeam.length;
        }
    }
    
    // Sort each team: goalies first, then alphabetically by first name
    const sortTeam = (team) => {
        return team.sort((a, b) => {
            // Goalies always on top
            if (a.isGoalie && !b.isGoalie) return -1;
            if (!a.isGoalie && b.isGoalie) return 1;
            // Then alphabetical by first name
            const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
            const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
            return nameA.localeCompare(nameB);
        });
    };
    
    whiteTeam = sortTeam(whiteTeam);
    darkTeam = sortTeam(darkTeam);
    
    // Update players array with team assignments
    players = [...whiteTeam, ...darkTeam];
    
    return { whiteTeam, darkTeam, whiteRating, darkRating };
}

async function saveWeekHistory(year, weekNumber, whiteTeam, darkTeam) {
    try {
        const whiteAvg = (whiteTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0) / whiteTeam.length).toFixed(1);
        const darkAvg = (darkTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0) / darkTeam.length).toFixed(1);
        
        await pool.query(
            `INSERT INTO history (week_number, year, release_date, game_location, game_time, game_date, white_team, dark_team, white_avg, dark_avg)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                weekNumber,
                year,
                new Date(),
                gameLocation,
                gameTime,
                gameDate,
                JSON.stringify(whiteTeam),
                JSON.stringify(darkTeam),
                whiteAvg,
                darkAvg
            ]
        );
        
        console.log(`Week history saved: Week ${weekNumber}, ${year}`);
    } catch (err) {
        console.error('Error saving week history:', err);
    }
}

async function getHistoryList() {
    try {
        const res = await pool.query(
            'SELECT week_number, year, release_date FROM history ORDER BY year DESC, week_number DESC'
        );
        return res.rows.map(row => ({
            weekNumber: row.week_number,
            year: row.year,
            created: row.release_date
        }));
    } catch (err) {
        console.error('Error reading history:', err);
        return [];
    }
}

async function getWeekHistory(year, weekNumber) {
    try {
        const res = await pool.query(
            'SELECT * FROM history WHERE year = $1 AND week_number = $2',
            [year, weekNumber]
        );
        
        if (res.rows.length > 0) {
            const row = res.rows[0];
            return {
                weekNumber: row.week_number,
                year: row.year,
                releaseDate: row.release_date,
                gameLocation: row.game_location,
                gameTime: row.game_time,
                gameDate: row.game_date,
                whiteTeam: row.white_team,
                darkTeam: row.dark_team,
                whiteTeamAvg: row.white_avg,
                darkTeamAvg: row.dark_avg
            };
        }
        return null;
    } catch (err) {
        console.error('Error reading week history:', err);
        return null;
    }
}

// --- NEW: DELETE HISTORY FUNCTION ---
async function deleteWeekHistory(year, weekNumber) {
    try {
        const res = await pool.query(
            'DELETE FROM history WHERE year = $1 AND week_number = $2 RETURNING *',
            [year, weekNumber]
        );
        
        if (res.rowCount > 0) {
            console.log(`[DELETE HISTORY] ✅ Deleted Week ${weekNumber}, ${year}`);
            return { success: true, deleted: res.rowCount };
        } else {
            console.log(`[DELETE HISTORY] ⚠️ Week ${weekNumber}, ${year} not found`);
            return { success: false, error: "Week not found in history" };
        }
    } catch (err) {
        console.error('[DELETE HISTORY] ❌ Error:', err);
        return { success: false, error: err.message };
    }
}

// --- ROUTES ---

// DEBUG ROUTES - Remove in production
app.get('/api/debug-time', (req, res) => {
    const now = new Date();
    const etTime = getCurrentETTime();
    const shouldLock = shouldBeLocked();
    
    res.json({
        systemTime: now.toISOString(),
        systemTimeLocal: now.toString(),
        systemDay: now.getDay(),
        systemHour: now.getHours(),
        etTime: etTime.toISOString(),
        etTimeLocal: etTime.toString(),
        etDay: etTime.getDay(),
        etHour: etTime.getHours(),
        shouldBeLocked: shouldLock,
        requirePlayerCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        rosterReleased: rosterReleased
    });
});

app.get('/api/force-check', (req, res) => {
    const result = checkAutoLock();
    res.json({ 
        message: 'Lock check forced',
        ...result,
        timestamp: new Date().toISOString()
    });
});

// Regular routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/waitlist', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'waitlist.html'));
});

app.get('/roster', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'roster.html'));
});

app.get('/history', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/rules', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rules.html'));
});

// --- PUBLIC API ---
app.get('/api/status', (req, res) => {
    // FIXED: Always run checkAutoLock to get current state
    const lockStatus = checkAutoLock();
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    
    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    
    res.json({
        playerSpotsRemaining: playerSpots > 0 ? playerSpots : 0,
        goalieCount: goalieCount,
        goalieSpotsAvailable: MAX_GOALIES - goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        isFull: playerSpots === 0,
        waitlistCount: waitlist.length,
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow,
        manualOverride: lockStatus.manualOverride,
        manualOverrideState: lockStatus.manualOverrideState,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        rosterReleased: rosterReleased,
        currentWeek: week,
        currentYear: year,
        rules: GAME_RULES,
        // Include players list for the signup page
        players: players.map(p => ({
            firstName: p.firstName,
            lastName: p.lastName,
            isGoalie: p.isGoalie,
            rating: p.rating
        }))
    });
});

app.get('/api/waitlist', (req, res) => {
    const waitlistNames = waitlist.map((p, index) => ({
        position: index + 1,
        fullName: `${p.firstName} ${p.lastName}`,
        isGoalie: p.isGoalie
    }));
    
    res.json({
        waitlist: waitlistNames,
        totalWaitlist: waitlist.length,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate)
    });
});

// --- MODIFIED: Roster API with proper sorting ---
app.get('/api/roster', (req, res) => {
    if (!rosterReleased) {
        return res.json({
            released: false,
            message: "Roster has not been released yet",
            releaseTime: "Check with admin"
        });
    }
    
    // Sort function: goalies first, then alphabetically by first name
    const sortPlayers = (a, b) => {
        if (a.isGoalie && !b.isGoalie) return -1;
        if (!a.isGoalie && b.isGoalie) return 1;
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    };
    
    const whiteTeam = players.filter(p => p.team === 'White').sort(sortPlayers);
    const darkTeam = players.filter(p => p.team === 'Dark').sort(sortPlayers);
    
    const whiteRating = whiteTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0);
    const darkRating = darkTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0);
    
    res.json({
        released: true,
        whiteTeam,
        darkTeam,
        whiteRating: (whiteRating / whiteTeam.length).toFixed(1),
        darkRating: (darkRating / darkTeam.length).toFixed(1),
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        weekNumber: currentWeekData.weekNumber,
        year: currentWeekData.year
    });
});

// History API
app.get('/api/history', async (req, res) => {
    const history = await getHistoryList();
    res.json({ history });
});

app.get('/api/history/:year/:week', async (req, res) => {
    const { year, week } = req.params;
    const weekData = await getWeekHistory(parseInt(year), parseInt(week));
    
    if (weekData) {
        res.json(weekData);
    } else {
        res.status(404).json({ error: "Week not found" });
    }
});

// --- NEW: DELETE HISTORY ENDPOINT ---
app.delete('/api/admin/history/:year/:week', async (req, res) => {
    const { password, sessionToken } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    const { year, week } = req.params;
    const yearNum = parseInt(year);
    const weekNum = parseInt(week);
    
    if (isNaN(yearNum) || isNaN(weekNum)) {
        return res.status(400).json({ error: "Invalid year or week number" });
    }
    
    console.log(`[DELETE HISTORY] Admin requested deletion of Week ${weekNum}, ${yearNum}`);
    
    const result = await deleteWeekHistory(yearNum, weekNum);
    
    if (result.success) {
        res.json({ 
            success: true, 
            message: `Week ${weekNum}, ${yearNum} deleted from history`,
            deleted: result.deleted
        });
    } else {
        res.status(404).json({ error: result.error });
    }
});

app.post('/api/verify-code', (req, res) => {
    checkAutoLock();
    
    const { code } = req.body;
    
    if (!requirePlayerCode) {
        return res.json({ valid: true, message: "Signup is open to all" });
    }
    
    if (code === playerSignupCode) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false, error: "Invalid code" });
    }
});

// Step 1: Initial registration
app.post('/api/register-init', async (req, res) => {
    checkAutoLock();
    
    if (requirePlayerCode) {
        const { signupCode } = req.body;
        if (signupCode !== playerSignupCode) {
            return res.status(401).json({ error: "Invalid or missing signup code" });
        }
    }
    
    const { firstName, lastName, phone, paymentMethod, rating } = req.body;

    if (!firstName || !lastName || !phone || !paymentMethod || !rating) {
        return res.status(400).json({ error: "All fields are required." });
    }

    if (isDuplicatePlayer(firstName, lastName, phone)) {
        return res.status(400).json({ error: "A player with this name or phone number is already registered." });
    }

    if (!validatePhoneNumber(phone)) {
        return res.status(400).json({ error: "Please enter a valid 10-digit phone number." });
    }

    const ratingNum = parseInt(rating);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 10) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 10." });
    }
    
    if (playerSpots <= 0) {
        const formattedPhone = formatPhoneNumber(phone);
        const waitlistPlayer = {
            id: Date.now(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formattedPhone,
            paymentMethod,
            rating: ratingNum,
            isGoalie: false,
            joinedAt: new Date()
        };

        try {
            await pool.query(
                `INSERT INTO waitlist (id, first_name, last_name, phone, payment_method, rating, is_goalie)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName, 
                 waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating, false]
            );
            waitlist.push(waitlistPlayer);
        } catch (err) {
            console.error('Error adding to waitlist:', err);
        }
        
        return res.json({
            success: true,
            inWaitlist: true,
            waitlistPosition: waitlist.length,
            message: "Game is full. You have been added to the waitlist."
        });
    }

    res.json({ 
        success: true, 
        proceedToRules: true,
        isGoalie: false,
        tempData: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formatPhoneNumber(phone),
            paymentMethod,
            rating: ratingNum,
            isGoalie: false
        }
    });
});

// Step 2: Final registration
app.post('/api/register-final', async (req, res) => {
    const { tempData, rulesAgreed } = req.body;
    
    if (!rulesAgreed) {
        return res.status(400).json({ error: "You must agree to the rules to register." });
    }
    
    if (!tempData || !tempData.firstName) {
        return res.status(400).json({ error: "Registration data missing." });
    }
    
    if (isDuplicatePlayer(tempData.firstName, tempData.lastName, tempData.phone)) {
        return res.status(400).json({ error: "A player with this name or phone number is already registered." });
    }
    
    const newPlayer = {
        id: Date.now(),
        firstName: tempData.firstName,
        lastName: tempData.lastName,
        phone: tempData.phone,
        paymentMethod: tempData.paymentMethod,
        paid: false,
        rating: parseInt(tempData.rating) || 5,
        isGoalie: false,
        team: null,
        registeredAt: new Date().toISOString(),
        rulesAgreed: true
    };

    try {
        await pool.query(
            `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, rating, is_goalie, team, rules_agreed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
             newPlayer.paymentMethod, newPlayer.paid, newPlayer.rating, false, null, true]
        );
        players.push(newPlayer);
        playerSpots--;
        await saveData();
    } catch (err) {
        console.error('Error saving player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    res.json({ 
        success: true, 
        inWaitlist: false,
        message: `You're registered! Payment must be received by Sunday 12PM or your spot will be offered to the next person on the waitlist.`,
        paymentDeadline: "Sunday 12PM",
        rosterReleaseTime: "Teams released after admin generates roster",
        isGoalie: false
    });
});

// --- ADMIN API ---
app.post('/api/admin/check-session', (req, res) => {
    const { sessionToken } = req.body;
    if (adminSessions[sessionToken]) {
        res.json({ loggedIn: true });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const sessionToken = Date.now().toString() + Math.random().toString();
        adminSessions[sessionToken] = true;
        res.json({ success: true, sessionToken: sessionToken });
    } else {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/players', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    
    res.json({ 
        playerSpots, 
        playerCount,
        goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        players, 
        waitlist, 
        location: gameLocation, 
        time: gameTime,
        date: gameDate,
        rosterReleased, 
        currentWeekData, 
        playerSignupCode, 
        requirePlayerCode 
    });
});

app.post('/api/admin/settings', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    // FIXED: Run check to get current lock status
    const lockStatus = checkAutoLock();
    
    res.json({
        code: playerSignupCode,
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        rosterReleased
    });
});

app.post('/api/admin/update-details', (req, res) => {
    const { password, sessionToken, location, time, date } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    if (location && location.trim().length > 0) {
        gameLocation = location.trim();
    }
    if (time && time.trim().length > 0) {
        gameTime = time.trim();
    }
    if (date && date.trim().length > 0) {
        gameDate = date.trim();
    }
    
    saveData();
    
    res.json({ 
        success: true, 
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate)
    });
});

app.post('/api/admin/update-code', (req, res) => {
    const { password, sessionToken, newCode } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized - invalid session" });
    }
    
    if (!newCode || !/^\d{4}$/.test(newCode)) {
        return res.status(400).json({ error: "Code must be exactly 4 digits" });
    }
    
    playerSignupCode = newCode;
    saveData();
    
    console.log('Code updated to:', playerSignupCode);
    
    res.json({ 
        success: true, 
        code: playerSignupCode, 
        requireCode: requirePlayerCode 
    });
});

// --- MODIFIED: Toggle code with manual override support ---
app.post('/api/admin/toggle-code', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    // Toggle the current state and set manual override
    const newRequireCode = !requirePlayerCode;
    
    requirePlayerCode = newRequireCode;
    manualOverride = true;
    manualOverrideState = newRequireCode ? 'locked' : 'open';
    
    saveData();
    
    console.log(`[ADMIN] Manual override set: ${manualOverrideState}`);
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        code: playerSignupCode 
    });
});

// --- MODIFIED: Reset schedule to auto mode ---
app.post('/api/admin/reset-schedule', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    // Clear manual override and let auto-schedule take over
    manualOverride = false;
    manualOverrideState = null;
    
    // Run check to apply correct auto state
    const result = checkAutoLock();
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        message: "Auto-schedule restored"
    });
});

app.post('/api/admin/promote-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const index = waitlist.findIndex(p => p.id === waitlistId);
    if (index === -1) {
        return res.status(404).json({ error: "Player not found in waitlist" });
    }

    const player = waitlist.splice(index, 1)[0];
    
    const newPlayer = {
        id: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        phone: player.phone,
        paymentMethod: player.paymentMethod,
        paid: false,
        rating: parseInt(player.rating) || 5,
        isGoalie: player.isGoalie,
        team: null
    };
    
    try {
        await pool.query(
            `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, rating, is_goalie, team)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
             newPlayer.paymentMethod, newPlayer.paid, newPlayer.rating, newPlayer.isGoalie, null]
        );
        players.push(newPlayer);
        
        if (!player.isGoalie && playerSpots > 0) {
            playerSpots--;
        }
        
        await saveData();
    } catch (err) {
        console.error('Error promoting player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    res.json({ 
        success: true, 
        player: newPlayer,
        spots: playerSpots,
        override: playerSpots <= 0 && !player.isGoalie
    });
});

app.post('/api/admin/remove-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const index = waitlist.findIndex(p => p.id === waitlistId);
    if (index === -1) {
        return res.status(404).json({ error: "Player not found in waitlist" });
    }

    const player = waitlist.splice(index, 1)[0];
    
    try {
        await pool.query('DELETE FROM waitlist WHERE id = $1', [player.id]);
    } catch (err) {
        console.error('Error removing from waitlist:', err);
    }
    
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/add-player', async (req, res) => {
    const { password, sessionToken, firstName, lastName, phone, paymentMethod, rating, isGoalie, toWaitlist } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    if (!firstName || !lastName || !phone || !rating) {
        return res.status(400).json({ error: "First name, last name, phone, and rating required" });
    }

    if (!validatePhoneNumber(phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
    }

    const formattedPhone = formatPhoneNumber(phone);
    const ratingNum = parseInt(rating) || 5;
    const isGoalieBool = isGoalie || false;

    if (toWaitlist) {
        const waitlistPlayer = {
            id: Date.now(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formattedPhone,
            paymentMethod: paymentMethod || 'Cash',
            rating: ratingNum,
            isGoalie: isGoalieBool,
            joinedAt: new Date()
        };
        
        try {
            await pool.query(
                `INSERT INTO waitlist (id, first_name, last_name, phone, payment_method, rating, is_goalie)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName,
                 waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating, isGoalieBool]
            );
            waitlist.push(waitlistPlayer);
        } catch (err) {
            console.error('Error adding to waitlist:', err);
            return res.status(500).json({ error: "Database error" });
        }
        
        saveData();
        res.json({ success: true, player: waitlistPlayer, inWaitlist: true });
    } else {
        if (isGoalieBool && !isGoalieSpotsAvailable()) {
            return res.status(400).json({ error: "Goalie spots are full (maximum 2)." });
        }
        
        const newPlayer = {
            id: Date.now(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formattedPhone,
            paymentMethod: paymentMethod || 'Cash',
            paid: isGoalieBool ? true : false,
            rating: ratingNum,
            isGoalie: isGoalieBool,
            team: null
        };
        
        try {
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, rating, is_goalie, team)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                 newPlayer.paymentMethod, newPlayer.paid, newPlayer.rating, isGoalieBool, null]
            );
            players.push(newPlayer);
            
            if (!isGoalieBool && playerSpots > 0) {
                playerSpots--;
            }
            
            await saveData();
        } catch (err) {
            console.error('Error adding player:', err);
            return res.status(500).json({ error: "Database error" });
        }
        
        res.json({ success: true, player: newPlayer, inWaitlist: false });
    }
});

// --- FIXED: Remove player with proper ID handling ---
app.post('/api/admin/remove-player', async (req, res) => {
    const { password, sessionToken, playerId } = req.body;
    
    console.log('[REMOVE PLAYER] Request received:', { playerId, hasSession: !!sessionToken });
    
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        console.log('[REMOVE PLAYER] Unauthorized');
        return res.status(401).send("Unauthorized");
    }

    // Convert playerId to number if it's a string
    const idToRemove = parseInt(playerId);
    if (isNaN(idToRemove)) {
        console.log('[REMOVE PLAYER] Invalid player ID:', playerId);
        return res.status(400).json({ error: "Invalid player ID" });
    }

    const index = players.findIndex(p => p.id === idToRemove);
    console.log('[REMOVE PLAYER] Found player at index:', index);
    
    if (index === -1) {
        console.log('[REMOVE PLAYER] Player not found with ID:', idToRemove);
        return res.status(404).json({ error: "Player not found" });
    }

    const wasGoalie = players[index].isGoalie;
    const player = players.splice(index, 1)[0];
    
    console.log('[REMOVE PLAYER] Removing player:', player.firstName, player.lastName);
    
    try {
        await pool.query('DELETE FROM players WHERE id = $1', [player.id]);
        
        if (!wasGoalie) {
            playerSpots++;
        }
        
        await saveData();
        console.log('[REMOVE PLAYER] Success! New spots:', playerSpots);
    } catch (err) {
        console.error('[REMOVE PLAYER] Error:', err);
        return res.status(500).json({ error: "Database error" });
    }

    res.json({ success: true, spots: playerSpots, removedPlayer: player });
});

app.post('/api/admin/update-spots', (req, res) => {
    const { password, sessionToken, newSpots } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const spotCount = parseInt(newSpots);
    if (isNaN(spotCount) || spotCount < 0 || spotCount > 30) {
        return res.status(400).json({ error: "Invalid spot count (0-30 allowed)" });
    }
    
    playerSpots = spotCount;
    saveData();
    res.json({ success: true, spots: playerSpots });
});

app.post('/api/admin/toggle-paid', async (req, res) => {
    const { password, sessionToken, playerId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const player = players.find(p => p.id === playerId);
    if (player) {
        player.paid = !player.paid;
        
        try {
            await pool.query('UPDATE players SET paid = $1 WHERE id = $2', [player.paid, player.id]);
        } catch (err) {
            console.error('Error toggling paid:', err);
        }
        
        saveData();
        res.json({ success: true, player });
    } else {
        res.status(404).send("Player not found");
    }
});

// --- FIXED: Manual roster release with guaranteed lock ---
app.post('/api/admin/release-roster', async (req, res) => {
    const { password, sessionToken } = req.body;
    
    console.log('[MANUAL RELEASE] Request received');
    
    if (!adminSessions[sessionToken]) {
        console.log('[MANUAL RELEASE] Unauthorized: Invalid session');
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    if (players.length === 0) {
        console.log('[MANUAL RELEASE] No players to release');
        return res.status(400).json({ error: "No players registered yet" });
    }
    
    try {
        const etTime = getCurrentETTime();
        const { week, year } = getWeekNumber(etTime);
        
        console.log('[MANUAL RELEASE] Generating teams...');
        const teams = generateFairTeams();
        
        // Set roster released FIRST
        rosterReleased = true;
        
        // LOCK SIGNUP IMMEDIATELY - Force lock regardless of time window
        requirePlayerCode = true;
        manualOverride = false;
        manualOverrideState = null;
        console.log('[MANUAL RELEASE] 🔒 Signup LOCKED after manual roster release');
        
        currentWeekData = {
            weekNumber: week,
            year: year,
            releaseDate: new Date().toISOString(),
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam
        };
        
        // Save team assignments to database
        for (const player of players) {
            await pool.query('UPDATE players SET team = $1 WHERE id = $2', [player.team, player.id]);
        }
        
        await saveWeekHistory(year, week, teams.whiteTeam, teams.darkTeam);
        await saveData();
        
        console.log('[MANUAL RELEASE] ✅ Success - Roster released and locked');
        
        res.json({ 
            success: true, 
            message: "Roster released successfully. Signup is now LOCKED.",
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam,
            whiteRating: teams.whiteRating.toFixed(1),
            darkRating: teams.darkRating.toFixed(1),
            signupLocked: true,
            rosterReleased: true
        });
    } catch (error) {
        console.error('[MANUAL RELEASE] ❌ Error:', error);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

app.post('/api/admin/manual-reset', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    if (rosterReleased && currentWeekData.weekNumber) {
        await saveWeekHistory(
            currentWeekData.year,
            currentWeekData.weekNumber,
            currentWeekData.whiteTeam,
            currentWeekData.darkTeam
        );
    }
    
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    
    playerSpots = 20;
    players = [];
    waitlist = [];
    rosterReleased = false;
    lastResetWeek = week;
    gameDate = calculateNextSunday();
    
    // Keep existing code - DO NOT generate new one
    // playerSignupCode stays the same
    
    currentWeekData = {
        weekNumber: week,
        year: year,
        releaseDate: null,
        whiteTeam: [],
        darkTeam: []
    };
    
    try {
        await pool.query('DELETE FROM players');
        await pool.query('DELETE FROM waitlist');
        await saveData();
    } catch (err) {
        console.error('Error resetting:', err);
    }
    
    res.json({ success: true, message: "Manual reset completed", code: playerSignupCode });
});

// Initialize database and start server
initDatabase().then(() => {
    // FIXED: Run initial checks immediately on startup
    console.log('[STARTUP] Running initial auto-lock check...');
    checkAutoLock();
    checkWeeklyReset();
    
    // Schedule auto roster release - runs every minute to check for exact 12:00 PM Sunday
    cron.schedule('* * * * *', () => {
        autoReleaseRoster();
    }, {
        timezone: 'America/New_York'
    });
    
    console.log('[CRON] Scheduled auto roster release check every minute (America/New_York)');
    
    app.listen(PORT, () => {
        console.log(`Phan's Sunday Hockey server running on port ${PORT}`);
        console.log(`Location: ${gameLocation}`);
        console.log(`Time: ${gameTime}`);
        console.log(`Date: ${gameDate}`);
        console.log(`Current signup code: ${playerSignupCode}`);
        console.log(`Current players registered: ${players.length}`);
        console.log(`Auto-lock status: ${requirePlayerCode ? 'LOCKED' : 'OPEN'}`);
        console.log(`Manual override: ${manualOverride}`);
    });
}).catch(err => {
    console.error('Failed to initialize database, starting with file fallback:', err);
    loadDataFromFile();
    
    // FIXED: Run checks even in fallback mode
    console.log('[STARTUP] Running initial auto-lock check (fallback mode)...');
    checkAutoLock();
    checkWeeklyReset();
    
    // Schedule auto roster release even in fallback mode
    cron.schedule('* * * * *', () => {
        autoReleaseRoster();
    }, {
        timezone: 'America/New_York'
    });
    
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (file fallback mode)`);
    });
});