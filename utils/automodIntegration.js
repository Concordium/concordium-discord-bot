/**
 * AutoMod exemption sync for "Ticket" text channels.
 * - Listens to Discord events: channelCreate / channelDelete (GuildText only).
 * - If the channel topic matches /Ticket/i, fetches the AutoMod rule (AUTOMOD_RULE_ID)
 *   and PATCHes its `exempt_channels` via Discord REST v10 to add/remove the channel.
 * - Uses axios for HTTP calls and reads env: DISCORD_GUILD_ID, DISCORD_BOT_TOKEN, AUTOMOD_RULE_ID.
 * - Idempotent (checks existing exemptions), logs results, and handles API errors gracefully.
 */

const axios = require("axios");
const { ChannelType } = require("discord.js");

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const AUTOMOD_RULE_ID = process.env.AUTOMOD_RULE_ID;

const ticketTopicPattern = /Ticket/i;

module.exports = function setupAutoModIntegration(client) {
    // Handle channel creation
    client.on("channelCreate", async (channel) => {
        if (channel.type !== ChannelType.GuildText) return;

        const topic = channel.topic || "";
        if (!ticketTopicPattern.test(topic)) return;

        try {
            const response = await axios.get(
                `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/auto-moderation/rules/${AUTOMOD_RULE_ID}`,
                {
                    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
                }
            );

            const rule = response.data;
            const updated = rule.exempt_channels || [];

            if (!updated.includes(channel.id)) {
                updated.push(channel.id);
                await axios.patch(
                    `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/auto-moderation/rules/${AUTOMOD_RULE_ID}`,
                    { exempt_channels: updated },
                    {
                        headers: {
                            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                            "Content-Type": "application/json"
                        }
                    }
                );
                console.log(`? AutoMod exemption added for channel: ${channel.name}`);
            }
        } catch (error) {
            console.error("? AutoMod exemption (add) failed:", error.response?.data || error);
        }
    });

    // Handle channel deletion
    client.on("channelDelete", async (channel) => {
        if (channel.type !== ChannelType.GuildText) return;

        const topic = channel.topic || "";
        if (!ticketTopicPattern.test(topic)) return;

        try {
            const response = await axios.get(
                `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/auto-moderation/rules/${AUTOMOD_RULE_ID}`,
                {
                    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
                }
            );

            const rule = response.data;
            const filtered = (rule.exempt_channels || []).filter((id) => id !== channel.id);

            await axios.patch(
                `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/auto-moderation/rules/${AUTOMOD_RULE_ID}`,
                { exempt_channels: filtered },
                {
                    headers: {
                        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            console.log(`? AutoMod exemption removed for deleted channel: ${channel.name}`);
        } catch (error) {
            console.error("? AutoMod exemption (remove) failed:", error.response?.data || error);
        }
    });
};