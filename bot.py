import datetime
import os

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
GUILD_ID = int(os.getenv("GUILD_ID", "1539036083918995526"))
MOD_LOG_WEBHOOK_URL = os.getenv("MOD_LOG_WEBHOOK_URL")
JOIN_LEAVE_WEBHOOK_URL = os.getenv("JOIN_LEAVE_WEBHOOK_URL")

intents = discord.Intents.default()
intents.members = True          # join date, roles, join/leave tracking
intents.message_content = True  # needed to see content in message edit/delete logs
intents.invites = True          # invite create/delete events


# --------------------------------------------------------------------- #
# Bot setup
# --------------------------------------------------------------------- #

class ProfileBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=intents)
        self.session: aiohttp.ClientSession | None = None
        self.mod_log_webhook: discord.Webhook | None = None
        self.join_leave_webhook: discord.Webhook | None = None

        # guild_id -> {invite_code: uses}
        self.invite_cache: dict[int, dict[str, int]] = {}
        self.vanity_cache: dict[int, int] = {}

    async def setup_hook(self):
        self.session = aiohttp.ClientSession()

        if MOD_LOG_WEBHOOK_URL:
            self.mod_log_webhook = discord.Webhook.from_url(MOD_LOG_WEBHOOK_URL, session=self.session)
        else:
            print("[warn] MOD_LOG_WEBHOOK_URL not set, mod logging disabled.")

        if JOIN_LEAVE_WEBHOOK_URL:
            self.join_leave_webhook = discord.Webhook.from_url(JOIN_LEAVE_WEBHOOK_URL, session=self.session)
        else:
            print("[warn] JOIN_LEAVE_WEBHOOK_URL not set, join/leave logging disabled.")

        # Syncs slash commands with Discord on startup
        await self.tree.sync()

    async def close(self):
        if self.session:
            await self.session.close()
        await super().close()


bot = ProfileBot()


def in_scope(guild: discord.Guild | None) -> bool:
    return guild is not None and guild.id == GUILD_ID


def fmt_user(user: discord.abc.User | None) -> str:
    if user is None:
        return "Unknown"
    return f"{user.mention} (`{user}` / `{user.id}`)"


# --------------------------------------------------------------------- #
# Components V2 "container" log helper
# --------------------------------------------------------------------- #

class LogContainerView(discord.ui.LayoutView):
    """One-off LayoutView wrapping a single Container. Built fresh per log entry."""

    def __init__(self, container: discord.ui.Container):
        super().__init__(timeout=None)
        self.add_item(container)


def build_container(
    *,
    title: str,
    lines: list[str],
    accent_color: discord.Color,
    footer: str | None = None,
    thumbnail_url: str | None = None,
) -> LogContainerView:
    body = f"### {title}\n" + "\n".join(lines)
    if footer:
        body += f"\n-# {footer}"

    text_display = discord.ui.TextDisplay(body)

    if thumbnail_url:
        section = discord.ui.Section(text_display, accessory=discord.ui.Thumbnail(thumbnail_url))
        container = discord.ui.Container(section, accent_color=accent_color)
    else:
        container = discord.ui.Container(text_display, accent_color=accent_color)

    return LogContainerView(container)


async def send_log(
    webhook: discord.Webhook | None,
    *,
    title: str,
    lines: list[str],
    accent_color: discord.Color,
    footer: str | None = None,
    thumbnail_url: str | None = None,
    username: str | None = None,
) -> None:
    if webhook is None:
        return

    view = build_container(
        title=title, lines=lines, accent_color=accent_color, footer=footer, thumbnail_url=thumbnail_url
    )
    try:
        await webhook.send(view=view, username=username, allowed_mentions=discord.AllowedMentions.none())
    except discord.HTTPException as exc:
        print(f"[log] failed to send log: {exc}")


async def mod_log(**kwargs):
    await send_log(bot.mod_log_webhook, username="Mod Log", **kwargs)


async def join_leave_log(**kwargs):
    await send_log(bot.join_leave_webhook, username="Joins & Leaves", **kwargs)


# --------------------------------------------------------------------- #
# Invite tracking
# --------------------------------------------------------------------- #

async def cache_invites(guild: discord.Guild):
    try:
        invites = await guild.invites()
        bot.invite_cache[guild.id] = {inv.code: inv.uses or 0 for inv in invites}
    except discord.Forbidden:
        print(f"[warn] missing Manage Server perms in {guild.id}, can't track invites.")
        bot.invite_cache[guild.id] = {}

    if "COMMUNITY" in guild.features or guild.vanity_url_code:
        try:
            vanity = await guild.vanity_invite()
            bot.vanity_cache[guild.id] = vanity.uses or 0
        except (discord.Forbidden, discord.HTTPException):
            pass


async def find_used_invite(guild: discord.Guild) -> str:
    """Diff current invite uses against cache to guess which invite was used."""
    before = bot.invite_cache.get(guild.id, {})

    try:
        current = await guild.invites()
    except discord.Forbidden:
        return "Unknown (missing Manage Server permission)"

    current_map = {inv.code: inv for inv in current}

    used_invite = None
    for inv in current:
        prior_uses = before.get(inv.code, 0)
        if (inv.uses or 0) > prior_uses:
            used_invite = inv
            break

    # An invite with max_uses=1 disappears entirely once used up.
    if used_invite is None:
        for code in before:
            if code not in current_map:
                used_invite = code  # only the code survives
                break

    # refresh cache regardless of outcome
    bot.invite_cache[guild.id] = {inv.code: inv.uses or 0 for inv in current}

    if guild.vanity_url_code:
        try:
            vanity = await guild.vanity_invite()
            prior_vanity = bot.vanity_cache.get(guild.id, 0)
            if (vanity.uses or 0) > prior_vanity:
                bot.vanity_cache[guild.id] = vanity.uses or 0
                return f"Vanity URL `discord.gg/{guild.vanity_url_code}`"
        except (discord.Forbidden, discord.HTTPException):
            pass

    if isinstance(used_invite, discord.Invite):
        inviter = used_invite.inviter
        inviter_str = f"{inviter.mention} (`{inviter}`)" if inviter else "Unknown"
        return f"`{used_invite.code}` created by {inviter_str} — {used_invite.uses} uses"
    elif isinstance(used_invite, str):
        return f"`{used_invite}` (single-use invite, now expired — inviter unknown)"
    else:
        return "Unknown (possibly a one-time link that already expired, or joined via Discovery)"


# --------------------------------------------------------------------- #
# Events: startup / invite cache maintenance
# --------------------------------------------------------------------- #

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} ({bot.user.id})")
    for guild in bot.guilds:
        if guild.id == GUILD_ID:
            await cache_invites(guild)


@bot.event
async def on_invite_create(invite: discord.Invite):
    if not in_scope(invite.guild):
        return
    bot.invite_cache.setdefault(invite.guild.id, {})[invite.code] = invite.uses or 0


@bot.event
async def on_invite_delete(invite: discord.Invite):
    if not in_scope(invite.guild):
        return
    bot.invite_cache.get(invite.guild.id, {}).pop(invite.code, None)


# --------------------------------------------------------------------- #
# Events: joins / leaves
# --------------------------------------------------------------------- #

@bot.event
async def on_member_join(member: discord.Member):
    if not in_scope(member.guild):
        return

    invite_info = await find_used_invite(member.guild)
    account_age = discord.utils.utcnow() - member.created_at
    age_flag = " ⚠️ **new account**" if account_age < datetime.timedelta(days=7) else ""

    await join_leave_log(
        title="📥 Member Joined",
        lines=[
            f"**User:** {member.mention} (`{member}` / `{member.id}`)",
            f"**Account created:** {discord.utils.format_dt(member.created_at, style='R')}{age_flag}",
            f"**Invite used:** {invite_info}",
            f"**Member count:** {member.guild.member_count}",
        ],
        accent_color=discord.Color.green(),
        thumbnail_url=member.display_avatar.url,
    )


@bot.event
async def on_member_remove(member: discord.Member):
    if not in_scope(member.guild):
        return

    joined = member.joined_at
    stayed = ""
    if joined:
        delta = discord.utils.utcnow() - joined
        stayed = f" (in server for {delta.days} days)"

    roles = [r.mention for r in member.roles if r.name != "@everyone"]
    roles_str = ", ".join(roles) if roles else "None"

    await join_leave_log(
        title="📤 Member Left",
        lines=[
            f"**User:** {member.mention} (`{member}` / `{member.id}`)",
            f"**Joined:** "
            + (discord.utils.format_dt(joined, style="R") if joined else "Unknown")
            + stayed,
            f"**Roles had:** {roles_str}",
            f"**Member count:** {member.guild.member_count}",
        ],
        accent_color=discord.Color.red(),
        thumbnail_url=member.display_avatar.url,
    )


# --------------------------------------------------------------------- #
# Events: message edits / deletes
# --------------------------------------------------------------------- #

@bot.event
async def on_message_delete(message: discord.Message):
    if not in_scope(message.guild) or message.author.bot:
        return
    content = message.content or "*(no text content — embed/attachment/etc.)*"
    if len(content) > 800:
        content = content[:800] + "…"
    await mod_log(
        title="🗑️ Message Deleted",
        lines=[
            f"**Author:** {fmt_user(message.author)}",
            f"**Channel:** {message.channel.mention}",
            f"**Content:**\n{content}",
        ],
        accent_color=discord.Color.orange(),
        footer=f"Message ID: {message.id}",
    )


@bot.event
async def on_bulk_message_delete(messages: list[discord.Message]):
    if not messages or not in_scope(messages[0].guild):
        return
    channel = messages[0].channel
    await mod_log(
        title="🧹 Bulk Message Delete",
        lines=[
            f"**Channel:** {channel.mention}",
            f"**Count:** {len(messages)} messages purged",
        ],
        accent_color=discord.Color.orange(),
    )


@bot.event
async def on_message_edit(before: discord.Message, after: discord.Message):
    if not in_scope(before.guild) or before.author.bot:
        return
    if before.content == after.content:
        return  # embed load, pin, etc. — not a real edit

    def trim(s: str) -> str:
        s = s or "*(empty)*"
        return s if len(s) <= 400 else s[:400] + "…"

    await mod_log(
        title="✏️ Message Edited",
        lines=[
            f"**Author:** {fmt_user(before.author)}",
            f"**Channel:** {before.channel.mention}",
            f"**Before:**\n{trim(before.content)}",
            f"**After:**\n{trim(after.content)}",
        ],
        accent_color=discord.Color.gold(),
        footer=f"Message ID: {before.id}",
    )


# --------------------------------------------------------------------- #
# Events: audit-log driven mod actions (bans, kicks, timeouts, roles, channels)
# --------------------------------------------------------------------- #

@bot.event
async def on_audit_log_entry_create(entry: discord.AuditLogEntry):
    if not in_scope(entry.guild):
        return

    handler = {
        discord.AuditLogAction.ban: on_ban,
        discord.AuditLogAction.unban: on_unban,
        discord.AuditLogAction.kick: on_kick,
        discord.AuditLogAction.member_update: on_member_update,
        discord.AuditLogAction.member_role_update: on_role_update,
        discord.AuditLogAction.channel_create: on_channel_create,
        discord.AuditLogAction.channel_delete: on_channel_delete,
        discord.AuditLogAction.role_create: on_role_create,
        discord.AuditLogAction.role_delete: on_role_delete,
    }.get(entry.action)

    if handler:
        await handler(entry)


async def on_ban(entry: discord.AuditLogEntry):
    await mod_log(
        title="🔨 Member Banned",
        lines=[
            f"**User:** {fmt_user(entry.target)}",
            f"**By:** {fmt_user(entry.user)}",
            f"**Reason:** {entry.reason or 'No reason given'}",
        ],
        accent_color=discord.Color.red(),
    )


async def on_unban(entry: discord.AuditLogEntry):
    await mod_log(
        title="⚖️ Member Unbanned",
        lines=[f"**User:** {fmt_user(entry.target)}", f"**By:** {fmt_user(entry.user)}"],
        accent_color=discord.Color.green(),
    )


async def on_kick(entry: discord.AuditLogEntry):
    await mod_log(
        title="👢 Member Kicked",
        lines=[
            f"**User:** {fmt_user(entry.target)}",
            f"**By:** {fmt_user(entry.user)}",
            f"**Reason:** {entry.reason or 'No reason given'}",
        ],
        accent_color=discord.Color.dark_orange(),
    )


async def on_member_update(entry: discord.AuditLogEntry):
    # Timeouts show up as a member_update entry with a communication_disabled_until change.
    before = getattr(entry.before, "timed_out_until", None)
    after = getattr(entry.after, "timed_out_until", None)
    if before == after:
        return  # some other member_update (nickname, etc.) — skip, too noisy

    if after:
        await mod_log(
            title="🔇 Member Timed Out",
            lines=[
                f"**User:** {fmt_user(entry.target)}",
                f"**By:** {fmt_user(entry.user)}",
                f"**Until:** {discord.utils.format_dt(after, style='F')}",
                f"**Reason:** {entry.reason or 'No reason given'}",
            ],
            accent_color=discord.Color.dark_gold(),
        )
    else:
        await mod_log(
            title="🔊 Timeout Removed",
            lines=[f"**User:** {fmt_user(entry.target)}", f"**By:** {fmt_user(entry.user)}"],
            accent_color=discord.Color.green(),
        )


async def on_role_update(entry: discord.AuditLogEntry):
    added = getattr(entry.after, "roles", None) or []
    removed = getattr(entry.before, "roles", None) or []
    lines = [f"**User:** {fmt_user(entry.target)}", f"**By:** {fmt_user(entry.user)}"]
    if added:
        lines.append("**Added:** " + ", ".join(r.mention for r in added))
    if removed:
        lines.append("**Removed:** " + ", ".join(r.mention for r in removed))
    await mod_log(title="🎭 Member Roles Updated", lines=lines, accent_color=discord.Color.blurple())


async def on_channel_create(entry: discord.AuditLogEntry):
    await mod_log(
        title="➕ Channel Created",
        lines=[
            f"**Channel:** {entry.target.mention if hasattr(entry.target, 'mention') else entry.target}",
            f"**By:** {fmt_user(entry.user)}",
        ],
        accent_color=discord.Color.green(),
    )


async def on_channel_delete(entry: discord.AuditLogEntry):
    name = getattr(entry.target, "name", entry.target)
    await mod_log(
        title="➖ Channel Deleted",
        lines=[f"**Channel:** #{name}", f"**By:** {fmt_user(entry.user)}"],
        accent_color=discord.Color.red(),
    )


async def on_role_create(entry: discord.AuditLogEntry):
    await mod_log(
        title="➕ Role Created",
        lines=[
            f"**Role:** {entry.target.mention if hasattr(entry.target, 'mention') else entry.target}",
            f"**By:** {fmt_user(entry.user)}",
        ],
        accent_color=discord.Color.green(),
    )


async def on_role_delete(entry: discord.AuditLogEntry):
    name = getattr(entry.target, "name", entry.target)
    await mod_log(
        title="➖ Role Deleted",
        lines=[f"**Role:** {name}", f"**By:** {fmt_user(entry.user)}"],
        accent_color=discord.Color.red(),
    )


# --------------------------------------------------------------------- #
# Slash commands
# --------------------------------------------------------------------- #

@bot.tree.command(name="profile", description="View a user's profile")
@app_commands.describe(user="The user to look up (leave blank for yourself)")
async def profile(interaction: discord.Interaction, user: discord.User = None):
    target = user or interaction.user
    # fetch_user hits the API directly, which is required to get banner data
    fetched = await bot.fetch_user(target.id)
    embed = discord.Embed(title=f"{fetched.name}'s Profile", color=discord.Color.blurple())
    embed.set_thumbnail(url=fetched.display_avatar.url)
    embed.add_field(name="Username", value=str(fetched), inline=True)
    embed.add_field(name="ID", value=fetched.id, inline=True)
    embed.add_field(
        name="Account Created",
        value=discord.utils.format_dt(fetched.created_at, style="F"),
        inline=False,
    )
    member = interaction.guild.get_member(target.id) if interaction.guild else None
    if member:
        if member.joined_at:
            embed.add_field(
                name="Joined Server",
                value=discord.utils.format_dt(member.joined_at, style="F"),
                inline=False,
            )
        roles = [role.mention for role in member.roles if role.name != "@everyone"]
        if roles:
            embed.add_field(name="Roles", value=" ".join(roles), inline=False)
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="banner", description="View a user's banner")
@app_commands.describe(user="The user to look up (leave blank for yourself)")
async def banner(interaction: discord.Interaction, user: discord.User = None):
    target = user or interaction.user
    fetched = await bot.fetch_user(target.id)
    if not fetched.banner:
        await interaction.response.send_message(
            f"{fetched.name} doesn't have a banner set.", ephemeral=True
        )
        return
    embed = discord.Embed(title=f"{fetched.name}'s Banner", color=discord.Color.blurple())
    embed.set_image(url=fetched.banner.url)
    await interaction.response.send_message(embed=embed)


if __name__ == "__main__":
    if not TOKEN:
        raise RuntimeError("DISCORD_TOKEN is not set. Add it to your .env file or Railway variables.")
    bot.run(TOKEN)
