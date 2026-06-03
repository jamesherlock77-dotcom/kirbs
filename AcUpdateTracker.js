const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, Collection, REST, Routes, ApplicationCommandOptionType, MessageFlags } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const chalk = require('chalk');

// --- Configuration (Safe Cloud Variables) ---
const TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const GUILD_ID = process.env.GUILD_ID || '';
const META_CHANNEL_ID = process.env.META_CHANNEL_ID || '';
const LINK_CHANNEL_ID = process.env.LINK_CHANNEL_ID || '';
const OWNER_USER_IDS = (process.env.OWNER_USER_IDS || '1012186051105804289').split(','); 
const UPDATE_ROLE_ID = process.env.UPDATE_ROLE_ID || '1463264519953580218'; 

const BOT_NAME = 'tack';

// Meta Oculus GraphQL API Constants
const GRAPHQL_URL = 'https://graph.oculus.com/graphql';
const ACCESS_TOKEN = 'OC|752908224809889|';
const APP_ID = '7190422614401072';
const DOC_ID = '6771539532935162';

const META_VERSION_FILE = './lastMetaVersion.json'; 
const LOG_FILE = './LastLog.txt';
const LINKED_USERS_FILE = './linkedUsers.txt';

let CHECK_INTERVAL = 60; // In seconds
let nextCheckTime = null;
let loopTimeout = null;

// --- Logger System ---
fs.writeFileSync(LOG_FILE, `=== Bot Started at ${new Date().toLocaleString()} ===\n`, 'utf8');
const origLog = console.log;
const origErr = console.error;

function writeToLogFile(text) { fs.appendFileSync(LOG_FILE, text + '\n', 'utf8'); }
console.log = (...args) => { writeToLogFile(`[LOG] ${args.join(' ')}`); origLog(...args); };
console.error = (...args) => { writeToLogFile(`[ERROR] ${args.join(' ')}`); origErr(...args); };

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
        case 'orange': origLog(chalk.hex('#FFA500')(msg)); break;
        default: origLog(msg);
    }
}

// --- Discord Client Setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.commands = new Collection();

// --- Meta Quest Store Asset Scraper ---
async function fetchStoreAssets() {
    try {
        // Fetch public store page to extract image assets directly from the application meta tags
        const response = await axios.get(`https://www.meta.com/experiences/${APP_ID}/`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        const html = response.data;

        // Pull OpenGraph images (the wide landscape banner)
        const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        let banner = ogImageMatch ? ogImageMatch[1].replace(/&amp;/g, '&') : null;

        // Pull application icon image
        const twitterImageMatch = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
        let icon = twitterImageMatch ? twitterImageMatch[1].replace(/&amp;/g, '&') : null;

        // Fallbacks if one tag fails
        if (!icon && banner) icon = banner;
        if (!banner && icon) banner = icon;

        return { icon, banner };
    } catch (err) {
        log(`Failed to fetch live store images: ${err.message}. Using backup assets.`, 'orange');
        return {
            icon: 'https://scontent.oculuscdn.com/v/t64.5771-25/75211516_2016335122100224_5701833512398516130_n.png',
            banner: 'https://scontent.oculuscdn.com/v/t64.5771-25/38974488_8194481023912111_6182390847110940652_n.png'
        };
    }
}

// --- Meta Oculus API Client ---
async function fetchMetaGameData() {
    try {
        const payload = new URLSearchParams({
            access_token: ACCESS_TOKEN,
            variables: JSON.stringify({ applicationID: APP_ID }),
            doc_id: DOC_ID
        });

        const response = await axios.post(GRAPHQL_URL, payload.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        });

        const data = response.data;
        const node = data?.data?.node;
        
        // Extract Live Version
        const liveNodes = node?.liveChannel?.nodes || [];
        const liveVersion = liveNodes[0]?.latest_supported_binary?.version || null;

        // Extract Dev Version
        const devNodes = node?.primary_binaries?.nodes || [];
        const devVersion = devNodes[0]?.version || null;

        // Fetch Assets dynamically from store engine
        const assets = await fetchStoreAssets();

        log(`API Fetch -> Live: ${liveVersion} | Dev: ${devVersion}`, 'green');
        return { live: liveVersion, dev: devVersion, icon: assets.icon, banner: assets.banner };
    } catch (err) {
        log(`Error calling Oculus GraphQL API: ${err.message}`, 'red');
        return null;
    }
}

// --- Local File Cache Storage ---
function getSavedVersions() {
    if (!fs.existsSync(META_VERSION_FILE)) return { live: null, dev: null };
    try {
        return JSON.parse(fs.readFileSync(META_VERSION_FILE, 'utf8'));
    } catch {
        return { live: null, dev: null };
    }
}
function saveVersions(live, dev) {
    fs.writeFileSync(META_VERSION_FILE, JSON.stringify({ live, dev }, null, 2), 'utf8');
}

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
async function notifyLinkedUsers(current, previous, branchName, assets) {
    const users = getLinkedUsers();
    if (!users.length) return;

    const now = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
        .setTitle(`🌍 Meta Update Detected!`)
        .setColor(0x00FF00) 
        .setDescription(`⏳ <t:${now}:F> (<t:${now}:R>)`)
        .addFields(
            { name: '🟢 | Updated Version:', value: `\`\`\`${current}\`\`\``, inline: true },
            { name: '🔴 | Last Logged:', value: previous ? `\`\`\`${previous}\`\`\`` : '`Unknown`', inline: true }
        );

    if (assets?.banner) embed.setImage(assets.banner);
    if (assets?.icon) embed.setThumbnail(assets.icon);

    const dmContent = `\n\n\n**Message from <@${client.user.id}>**\n\nAn update has been detected on the public release branch for Animal Company!\n\n🟢 **New Version:** ${current}\n🔴 **Last Version:** ${previous || 'Unknown'}\n\nTo stop receiving these notifications you can do **/unlink** in the same server you linked from\n\n-# coolio`;

    for (const userId of users) {
        try {
            const user = await client.users.fetch(userId);
            if (!user) continue;
            await user.send({
                content: dmContent,
                embeds: [embed]
            });
        } catch (err) { log(`Failed to DM ${userId}: ${err.message}`, 'red'); }
    }
}

async function sendMetaUpdateEmbed(current, previous, branchName, assets) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const isLive = branchName === 'Live';
        
        const embedColor = isLive ? 0x00FF00 : 0x2B2D31; 
        const titleText = isLive ? '🌍 Meta Update Detected!' : '🛠️ Developer Builds Update Detected!';

        const embed = new EmbedBuilder()
            .setTitle(titleText)
            .setColor(embedColor)
            .setDescription(`⏳ <t:${now}:F> (<t:${now}:R>)`)
            .addFields(
                { name: '🟢 | Updated Version:', value: `\`\`\`${current}\`\`\``, inline: true },
                { name: '🔴 | Last Logged:', value: previous ? `\`\`\`${previous}\`\`\`` : '`Unknown`', inline: true }
            );

        if (assets?.banner) embed.setImage(assets.banner);
        if (assets?.icon) embed.setThumbnail(assets.icon);

        const channel = await client.channels.fetch(META_CHANNEL_ID);
        
        const alertContent = isLive 
            ? `<@&${UPDATE_ROLE_ID}> **[${branchName} Branch Update Alert]**` 
            : `**[Silent Log] New build detected on Developer Branch.**`;

        await channel.send({ content: alertContent, embeds: [embed] });

        if (isLive) {
            await notifyLinkedUsers(current, previous, branchName, assets);
        }
        
        log(`Broadcasted ${branchName} update to channels.`, 'blue');
    } catch (err) { log('Error sending update embed: ' + err.message, 'red'); }
}

async function sendStartupEmbed(live, dev, assets) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const embed = new EmbedBuilder()
            .setTitle('Tracker System Online (GraphQL Live Assets)')
            .setColor(0x800080)
            .setDescription(`⏳ Status initialized <t:${now}:R>`)
            .addFields(
                { name: '🌍 Live Store Version', value: `\`\`\`${live || "Unknown"}\`\`\``, inline: true },
                { name: '🛠️ Developer Version', value: `\`\`\`${dev || "Unknown"}\`\`\``, inline: true }
            );

        if (assets?.icon) embed.setThumbnail(assets.icon);

        const channel = await client.channels.fetch(META_CHANNEL_ID);
        await channel.send({ embeds: [embed] });
    } catch (err) { log('Error sending startup embed: ' + err.message, 'red'); }
}

// --- Main Engine Loop ---
async function runTrackerLoop() {
    clearTimeout(loopTimeout);
    try {
        const saved = getSavedVersions();
        const current = await fetchMetaGameData();

        if (current) {
            let updated = false;
            const assets = { icon: current.icon, banner: current.banner };

            // Check Live Branch Change
            if (current.live && current.live !== saved.live) {
                await sendMetaUpdateEmbed(current.live, saved.live, 'Live', assets);
                saved.live = current.live;
                updated = true;
            }

            // Check Dev Branch Change
            if (current.dev && current.dev !== saved.dev) {
                await sendMetaUpdateEmbed(current.dev, saved.dev, 'Developer Builds', assets);
                saved.dev = current.dev;
                updated = true;
            }

            if (updated) {
                saveVersions(saved.live, saved.dev);
                try { client.user.setActivity(`Animal Company: ${saved.live || '?'}`, { type: ActivityType.Watching }); } catch {}
            }
        }
    } catch (err) { log(`Error inside core interval process loop: ${err.message}`, 'red'); }

    nextCheckTime = Date.now() + CHECK_INTERVAL * 1000;
    loopTimeout = setTimeout(runTrackerLoop, CHECK_INTERVAL * 1000);
}

// --- Slash Commands Setup ---
const commands = [
    { name: 'test', description: 'Triggers a mock alert layout using live cached stats' },
    { name: 'checkupdate', description: 'Instantly polls Oculus GraphQL data logs' },
    { name: 'log', description: 'Outputs the system text diagnostics logs' },
    { name: 'uptime', description: 'Returns active bot runtime statistics' },
    { name: 'settimer', description: 'Alters interval delay check value (seconds)', options: [{ name: 'seconds', type: ApplicationCommandOptionType.Integer, description: 'Seconds for loop execution', required: true }] }, 
    { name: 'link', description: 'Subscribe to Animal Company branch update logs' },
    { name: 'unlink', description: 'Stop receiving branch push alerts' },
    { name: 'message', description: 'Admin communication blast to subscribers', options: [{ name: 'text', type: ApplicationCommandOptionType.String, description: 'Text description body', required: true }] }
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
            await interaction.reply({ content: 'Linked successfully! Check your DMs.', flags: [MessageFlags.Ephemeral] });
            try { await user.send(`Hey <@${user.id}>! You've successfully locked in subscription alerts for Animal Company.`); } catch {}
        } else {
            await interaction.reply({ content: 'Account already configured into database tracking lists.', flags: [MessageFlags.Ephemeral] });
        }
        return;
    }

    if (commandName === 'unlink') {
        const removed = await removeLinkedUser(user.id);
        if (removed) {
            await interaction.reply({ content: '✅ Subscriptions disabled successfully.', flags: [MessageFlags.Ephemeral] });
        } else {
            await interaction.reply({ content: '⚠️ Profile wasn\'t actively bound inside subscription list profiles.', flags: [MessageFlags.Ephemeral] });
        }
        return;
    }

    // Admin Security Checking 
    if (!OWNER_USER_IDS.includes(user.id)) {
        return interaction.reply({ content: 'Action prohibited. Unauthorized operator credentials.', flags: [MessageFlags.Ephemeral] });
    }

    if (commandName === 'test') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const saved = getSavedVersions();
        const current = await fetchMetaGameData();
        const assets = { icon: current?.icon, banner: current?.banner };

        log(`Dispatched forced /test layout render for user profile ${user.tag}`, 'orange');
        
        await sendMetaUpdateEmbed(saved.live || '1.76.1.3001', '1.75.0.2900', 'Live', assets);
        await sendMetaUpdateEmbed(saved.dev || '1.77.2.3100', '1.76.1.3001', 'Developer Builds', assets);
        
        await interaction.editReply('✅ Double-mock branch test dispatches generated completely into channel directories.');
    }

    if (commandName === 'checkupdate') {
        await interaction.deferReply();
        const saved = getSavedVersions();
        const current = await fetchMetaGameData();

        if (!current) {
            return interaction.editReply('❌ API lookup operation terminated with standard communication errors.');
        }

        const assets = { icon: current.icon, banner: current.banner };
        let response = `**__Direct Manual API Audit Check Results:__**\n`;
        response += `🌍 **Live Branch:** Saved: \`${saved.live || 'None'}\` ➜ Direct API: \`${current.live || 'Error'}\`\n`;
        response += `🛠️ **Dev Branch:** Saved: \`${saved.dev || 'None'}\` ➜ Direct API: \`${current.dev || 'Error'}\`\n\n`;

        let updated = false;
        if (current.live && current.live !== saved.live) {
            await sendMetaUpdateEmbed(current.live, saved.live, 'Live', assets);
            saved.live = current.live;
            updated = true;
        }
        if (current.dev && current.dev !== saved.dev) {
            await sendMetaUpdateEmbed(current.dev, saved.dev, 'Developer Builds', assets);
            saved.dev = current.dev;
            updated = true;
        }

        if (updated) {
            saveVersions(saved.live, saved.dev);
            response += `⚡ *Discrepancies identified! Cache directories rewritten and alerts dispatched.*`;
        } else {
            response += `✅ *System cache matches live database mappings. No changes needed.*`;
        }

        await interaction.editReply(response);
    }

    if (commandName === 'log') {
        if (fs.existsSync(LOG_FILE)) await interaction.reply({ files: [LOG_FILE] });
        else await interaction.reply('Diagnostic documents empty or absent.');
    }

    if (commandName === 'uptime') {
        const uptime = process.uptime();
        await interaction.reply(`Bot execution uptime trace length: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`);
    }

    if (commandName === 'settimer') {
        const seconds = interaction.options.getInteger('seconds');
        if (seconds < 10) return interaction.reply('Interval timing rules restrict loops lower than 10 seconds.');
        CHECK_INTERVAL = seconds;
        nextCheckTime = Date.now() + CHECK_INTERVAL * 1000;
        clearTimeout(loopTimeout);
        loopTimeout = setTimeout(runTrackerLoop, CHECK_INTERVAL * 1000);
        await interaction.reply(`Execution sync loops established at dynamic tracking frequencies of every ${seconds} seconds.`);
    }

    if (commandName === 'message') {
        const messageText = interaction.options.getString('text');
        await interaction.reply({ content: 'Compiling blast vectors...', flags: [MessageFlags.Ephemeral] });
        const users = getLinkedUsers();
        let successCount = 0;
        let failCount = 0;

        const dmContent = `\n\n\n**Message from <@${interaction.user.id}>**\n\n"${messageText}"\n\nTo stop receiving these notifications you can do **/unlink** in the same server you linked from\n\n-# coolio`;

        for (const userId of users) {
            try {
                const userToDm = await client.users.fetch(userId);
                await userToDm.send(dmContent);
                successCount++;
            } catch {
                failCount++;
            }
        }
        await interaction.followUp({ content: `Broadcast complete. Sent: ${successCount} | Failed: ${failCount}`, flags: [MessageFlags.Ephemeral] });
    }
});

client.once('clientReady', async () => {
    log(`${BOT_NAME} logged in as ${client.user.tag}`, 'cyan');
    
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        log('Dynamic application command schemas injected successfully.', 'green');
    } catch (err) { log('Command loading exception error rules: ' + err.message, 'red'); }

    // First API Pull Setup
    const current = await fetchMetaGameData();
    const saved = getSavedVersions();
    
    if (current) {
        if (!saved.live) saved.live = current.live;
        if (!saved.dev) saved.dev = current.dev;
        saveVersions(saved.live, saved.dev);
        
        const assets = { icon: current.icon, banner: current.banner };
        try { client.user.setActivity(`Animal Company: ${saved.live || '?'}`, { type: ActivityType.Watching }); } catch {}
        await sendStartupEmbed(saved.live, saved.dev, assets);
    }

    nextCheckTime = Date.now() + CHECK_INTERVAL * 1000;
    loopTimeout = setTimeout(runTrackerLoop, CHECK_INTERVAL * 1000);
});

client.once('ready', () => {
    if (!client.isReady()) return;
    client.emit('clientReady');
});

if (TOKEN) {
    client.login(TOKEN);
} else {
    console.error("CRITICAL SETUP EXCEPTION: Environment configuration string variable 'DISCORD_TOKEN' absent.");
}
