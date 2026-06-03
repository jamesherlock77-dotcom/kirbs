const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, Collection, REST, Routes, ApplicationCommandOptionType, MessageFlags } = require('discord.js');
const puppeteer = require('puppeteer');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');

// --- Configuration (Safe Cloud Fallbacks) ---
const TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const GUILD_ID = process.env.GUILD_ID || '';
const META_CHANNEL_ID = process.env.META_CHANNEL_ID || '';
const LINK_CHANNEL_ID = process.env.LINK_CHANNEL_ID || '';
const OWNER_USER_IDS = (process.env.OWNER_USER_IDS || '1012186051105804289').split(','); 
const UPDATE_ROLE_ID = process.env.UPDATE_ROLE_ID || '1463264519953580218'; 

const BOT_NAME = 'tack';
const META_URL = 'https://www.meta.com/experiences/animal-company/7190422614401072/';
const BANNER_FILE = path.join(__dirname, 'banner.png');

const META_VERSION_FILE = './lastMetaVersion.txt';
const LOG_FILE = './LastLog.txt';
const LINKED_USERS_FILE = './linkedUsers.txt';

let CHECK_INTERVAL = 60; // In seconds
let nextCheckTime = null;
let countdownInterval = null;
let loopTimeout = null;

// --- Logger System ---
fs.writeFileSync(LOG_FILE, `=== Bot Started at ${new Date().toLocaleString()} ===\n`, 'utf8');
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;

function writeToLogFile(text) { fs.appendFileSync(LOG_FILE, text + '\n', 'utf8'); }
console.log = (...args) => { writeToLogFile(`[LOG] ${args.join(' ')}`); origLog(...args); };
console.error = (...args) => { writeToLogFile(`[ERROR] ${args.join(' ')}`); origErr(...args); };
console.warn = (...args) => { writeToLogFile(`[WARN] ${args.join(' ')}`); origWarn(...args); };

function log(text, color = 'white') {
    const timestamp = new Date().toLocaleString();
    const msg = `[${timestamp}] ${text}`;
    writeToLogFile(msg);
    switch(color) {
        case 'red': origLog(chalk.red(msg)); break;
        case 'green': origLog(chalk.green(msg)); break;
        case 'blue': origLog(chalk.blue(msg)); break;
        case 'magenta': origLog(chalk.magenta(msg)); break;
        case 'cyan': origLog(chalk.cyan(msg)); break;
        default: origLog(msg);
    }
}

// --- Discord Client Setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.commands = new Collection();

// --- Puppeteer Scraper ---
async function fetchMetaVersion() {
    let browser;
    try {
        const launchOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
        };
        
        if (process.platform === 'win32') {
            launchOptions.executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(META_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        const version = await page.evaluate(() => {
            const divs = Array.from(document.querySelectorAll('div'));
            for (const el of divs) {
                if (el.innerText && el.innerText.startsWith('Version')) {
                    return el.innerText.replace('Version', '').trim();
                }
            }
            return null;
        });

        log('Fetched Meta version: ' + version, 'green');
        return version;
    } catch (err) {
        log('Error fetching Meta version: ' + err.message, 'red');
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

// --- File Storage Utilities ---
function getLinkedUsers() {
    if (!fs.existsSync(LINKED_USERS_FILE)) return [];
    return fs.readFileSync(LINKED_USERS_FILE, 'utf8').split('\n').map(s => s.trim()).filter(s => s.length > 0);
}
function saveLinkedUsers(list) { fs.writeFileSync(LINKED_USERS_FILE, list.join('\n'), 'utf8'); }

async function addLinkedUser(userId) {
    const users = getLinkedUsers();
    if (!users.includes(userId)) {
        users.push(userId);
        saveLinkedUsers(users);
        return true;
    }
    return false;
}
async function removeLinkedUser(userId) {
    let users = getLinkedUsers();
    if (users.includes(userId)) {
        users = users.filter(u => u !== userId);
        saveLinkedUsers(users);
        return true;
    }
    return false;
}

// --- Notification Dispatches ---
async function notifyLinkedUsers(currentVersion, previousVersion) {
    const users = getLinkedUsers();
    if (!users.length) return log('No linked users to notify.', 'cyan');

    const now = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
        .setTitle('Meta\nUpdate Detected!')
        .setColor(0x800080)
        .setDescription(`⏳ <t:${now}:F> (<t:${now}:R>)`)
        .addFields(
            { name: '🟢 | Updated Version:', value: `\`\`\`${currentVersion}\`\`\``, inline: true },
            { name: '🔴 | Last Logged:', value: previousVersion || currentVersion, inline: true }
        )
        .setImage('attachment://banner.png');

    const dmMessage = `Hey there <@USER_ID> 👋\n\nWe're just letting you know we detected an update for Animal Company!\n\n🟢 Current Version: ${currentVersion}\n🔴 Last Version: ${previousVersion || 'Unknown'}\n\nTo stop receiving these notifications you can do:\n\`\`\`\n/unlink\n\`\`\`\n\nHave a good one!`;

    for (const userId of users) {
        try {
            const user = await client.users.fetch(userId);
            if (!user) continue;

            await user.send({
                content: dmMessage.replace('<@USER_ID>', `<@${userId}>`),
                embeds: [embed],
                files: [BANNER_FILE]
            });
            log(`DM sent to ${user.tag} (${userId})`, 'green');
        } catch (err) {
            log(`Failed to DM ${userId}: ${err.message}`, 'red');
        }
    }
}

async function sendMetaUpdateEmbed(current, previous) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const embed = new EmbedBuilder()
            .setTitle('Meta\nUpdate Detected!')
            .setColor(0x800080)
            .setDescription(`⏳ <t:${now}:F> (<t:${now}:R>)`)
            .addFields(
                { name: '🟢 | Updated Version:', value: `\`\`\`${current}\`\`\``, inline: true },
                { name: '🔴 | Last Logged:', value: previous || current, inline: true }
            )
            .setImage('attachment://banner.png');

        const channel = await client.channels.fetch(META_CHANNEL_ID);
        await channel.send({ content: `<@&${UPDATE_ROLE_ID}>`, embeds: [embed], files: [BANNER_FILE] });

        await notifyLinkedUsers(current, previous);
        log(`Sent Meta update embed. Current=${current}, Last=${previous}`, 'blue');
    } catch (err) { log('Error sending Meta embed: ' + err.message, 'red'); }
}

async function sendStartupEmbed(currentMetaVersion) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const embed = new EmbedBuilder()
            .setTitle('Tracker Started')
            .setColor(0x800080)
            .setDescription(`\nCurrent Animal Company Version: \`\`\`${currentMetaVersion || "Unknown"}\`\`\`\n⏳ <t:${now}:F> (<t:${now}:R>)`);

        const channel = await client.channels.fetch(META_CHANNEL_ID);
        await channel.send({ embeds: [embed] });
        log('Sent startup embed with current version.', 'green');
    } catch (err) { log('Error sending startup embed: ' + err.message, 'red'); }
}

// --- Main Loops ---
async function runTrackerLoop() {
    clearTimeout(loopTimeout);
    try {
        const lastMetaVersion = fs.existsSync(META_VERSION_FILE) ? fs.readFileSync(META_VERSION_FILE, 'utf8').trim() : null;
        const currentMetaVersion = await fetchMetaVersion();

        if (currentMetaVersion && currentMetaVersion !== lastMetaVersion) {
            fs.writeFileSync(META_VERSION_FILE, currentMetaVersion, 'utf8');
            try { client.user.setActivity(`Animal Company: ${currentMetaVersion}`, { type: ActivityType.Watching }); } catch {}
            await sendMetaUpdateEmbed(currentMetaVersion, lastMetaVersion);
        }
    } catch (err) { log(`Error inside engine processing loop: ${err.message}`, 'red'); }

    nextCheckTime = Date.now() + CHECK_INTERVAL * 1000;
    loopTimeout = setTimeout(runTrackerLoop, CHECK_INTERVAL * 1000);
}

function startCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        if (!nextCheckTime) return;
        const diff = Math.max(0, Math.floor((nextCheckTime - Date.now()) / 1000));
        const mins = Math.floor(diff / 60);
        const secs = diff % 60;
        if (process.platform === 'win32') {
            process.stdout.write(chalk.cyan(`Next check in: ${mins}m ${secs}s   \r`));
        }
    }, 1000);
}

// --- Slash Commands Definitions ---
const commands = [
    { name: 'test', description: 'Triggers a mock notification check using the last saved game version' },
    { name: 'checkupdate', description: 'Checks for updates manually' },
    { name: 'log', description: 'Gets the last log file' },
    { name: 'uptime', description: 'Shows the bot uptime' },
    { name: 'settimer', description: 'Sets the check timer (seconds)', options: [{ name: 'seconds', type: ApplicationCommandOptionType.Integer, description: 'Seconds for timer', required: true }] }, 
    { name: 'link', description: 'Subscribe to Animal Company update notifications' },
    { name: 'unlink', description: 'Unsubscribe from Animal Company update notifications' },
    { name: 'message', description: 'Broadcasts a message to all linked users', options: [{ name: 'text', type: ApplicationCommandOptionType.String, description: 'The message you want to send', required: true }] }
];

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, channelId, user } = interaction;
    log(`[COMMAND] /${commandName} executed by ${user.tag}`, 'magenta');

    if (commandName === 'link') {
        if (channelId !== LINK_CHANNEL_ID) {
            return interaction.reply({ content: `You can only use /link in <#${LINK_CHANNEL_ID}>.`, flags: [MessageFlags.Ephemeral] });
        }
        const added = await addLinkedUser(user.id);
        if (added) {
            await interaction.reply({ content: 'You have been linked! Check your DMs.', flags: [MessageFlags.Ephemeral] });
            try { await user.send(`Hey there <@${user.id}>!\n\nYou've been subscribed to Animal Company update notifications.`); } catch {}
        } else {
            await interaction.reply({ content: 'You are already linked!', flags: [MessageFlags.Ephemeral] });
        }
        return;
    }

    if (commandName === 'unlink') {
        const removed = await removeLinkedUser(user.id);
        if (removed) {
            await interaction.reply({ content: '✅ You have been unlinked!', flags: [MessageFlags.Ephemeral] });
        } else {
            await interaction.reply({ content: '⚠️ You are not currently linked!', flags: [MessageFlags.Ephemeral] });
        }
        return;
    }

    // Admin Permissions Guard
    if (!OWNER_USER_IDS.includes(user.id)) {
        return interaction.reply({ content: 'Unauthorised.', flags: [MessageFlags.Ephemeral] });
    }

    if (commandName === 'test') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const dummyVersion = fs.existsSync(META_VERSION_FILE) ? fs.readFileSync(META_VERSION_FILE, 'utf8').trim() : '1.0.0-TEST';
        
        log(`Running manual /test notification dispatch triggered by ${user.tag}`, 'orange');
        await sendMetaUpdateEmbed(dummyVersion, `${dummyVersion} (TEST-MOCK)`);
        
        await interaction.editReply('✅ Test notification sent successfully to your tracking channel and linked users.');
    }

    if (commandName === 'checkupdate') {
        await interaction.deferReply();
        const lastMetaVersion = fs.existsSync(META_VERSION_FILE) ? fs.readFileSync(META_VERSION_FILE, 'utf8').trim() : null;
        const currentMetaVersion = await fetchMetaVersion();
        if (currentMetaVersion && currentMetaVersion !== lastMetaVersion) {
            fs.writeFileSync(META_VERSION_FILE, currentMetaVersion, 'utf8');
            await sendMetaUpdateEmbed(currentMetaVersion, lastMetaVersion);
            await interaction.editReply(`✅ Update detected! Current: ${currentMetaVersion}`);
        } else {
            await interaction.editReply(`No update detected. Current: ${currentMetaVersion || 'Unknown'}`);
        }
    }

    if (commandName === 'log') {
        if (fs.existsSync(LOG_FILE)) await interaction.reply({ files: [LOG_FILE] });
        else await interaction.reply('No logs found.');
    }

    if (commandName === 'uptime') {
        const uptime = process.uptime();
        await interaction.reply(`Bot uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`);
    }

    if (commandName === 'settimer') {
        const seconds = interaction.options.getInteger('seconds');
        if (seconds < 60) return interaction.reply('Timer must be >= 60 seconds.');
        CHECK_INTERVAL = seconds;
        nextCheckTime = Date.now() + CHECK_INTERVAL * 1000;
        clearTimeout(loopTimeout);
        loopTimeout = setTimeout(runTrackerLoop, CHECK_INTERVAL * 1000);
        await interaction.reply(`Interval changed to ${seconds} seconds.`);
    }

    if (commandName === 'message') {
        const messageText = interaction.options.getString('text');
        await interaction.reply({ content: 'Broadcasting...', flags: [MessageFlags.Ephemeral] });
        const users = getLinkedUsers();
        let successCount = 0;
        for (const userId of users) {
            try {
                const userToDm = await client.users.fetch(userId);
                await userToDm.send(`\n\n**Message from Admin:**\n\n"${messageText}"`);
                successCount++;
            } catch {}
        }
        await interaction.followUp({ content: `Broadcast complete. Sent to ${successCount} users.`, flags: [MessageFlags.Ephemeral] });
    }
});

client.once('ready', async () => {
    log(`${BOT_NAME} logged in as ${client.user.tag}`, 'cyan');
    
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        log('Successfully registered slash commands.', 'green');
    } catch (err) { log('Failed to register application slash commands: ' + err.message, 'red'); }

    try {
        const currentMetaVersion = await fetchMetaVersion();
        if (currentMetaVersion) {
            fs.writeFileSync(META_VERSION_FILE, currentMetaVersion, 'utf8');
            client.user.setActivity(`Animal Company: ${currentMetaVersion}`, { type: ActivityType.Watching });
        }
        await sendStartupEmbed(currentMetaVersion);
    } catch (err) { log('Startup initialization error: ' + err.message, 'red'); }

    nextCheckTime = Date.now() + CHECK_INTERVAL * 1000;
    loopTimeout = setTimeout(runTrackerLoop, CHECK_INTERVAL * 1000);
    startCountdown();
});

if (TOKEN) {
    client.login(TOKEN);
} else {
    console.error("CRITICAL ERROR: Discord Token missing. Provide environment configuration variable 'DISCORD_TOKEN'.");
}
