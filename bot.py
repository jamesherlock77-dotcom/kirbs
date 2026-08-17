import os
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")

intents = discord.Intents.default()
intents.members = True  # lets us pull server-specific info (join date, roles)


class ProfileBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # Syncs slash commands with Discord on startup
        await self.tree.sync()


bot = ProfileBot()


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} ({bot.user.id})")


@bot.tree.command(name="profile", description="View a user's profile")
@app_commands.describe(user="The user to look up (leave blank for yourself)")
async def profile(interaction: discord.Interaction, user: discord.User = None):
    target = user or interaction.user
    # fetch_user hits the API directly, which is required to get banner data
    fetched = await bot.fetch_user(target.id)

    embed = discord.Embed(
        title=f"{fetched.name}'s Profile",
        color=discord.Color.blurple(),
    )
    embed.set_thumbnail(url=fetched.display_avatar.url)
    embed.add_field(name="Username", value=str(fetched), inline=True)
    embed.add_field(name="ID", value=fetched.id, inline=True)
    embed.add_field(
        name="Account Created",
        value=discord.utils.format_dt(fetched.created_at, style="F"),
        inline=False,
    )

    # If the command was run in a server and the target is a member there,
    # add server-specific info too
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
