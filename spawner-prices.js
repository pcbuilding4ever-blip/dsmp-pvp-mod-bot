const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, ChannelType, PermissionFlagsBits
} = require("discord.js");

const fs = require("fs");
const TICKET_CHANNEL_ID = "1553777212170178570";
const STOCK_FILE = "./spawner-stock.json";
const PANEL_FILE = "./spawner-panel.json";
const PANEL_CONTENT_FILE = "./spawner-panel-content.json";
const DEFAULT_STOCK = { iron_golem: 0, skeleton: 0 };

function loadStock() {
    try {
        const saved = JSON.parse(fs.readFileSync(STOCK_FILE, "utf8"));
        return {
            iron_golem: Number.isSafeInteger(saved.iron_golem) && saved.iron_golem >= 0 ? saved.iron_golem : 0,
            skeleton: Number.isSafeInteger(saved.skeleton) && saved.skeleton >= 0 ? saved.skeleton : 0
        };
    } catch {
        return { ...DEFAULT_STOCK };
    }
}

function saveStock(stock) {
    fs.writeFileSync(STOCK_FILE, JSON.stringify(stock, null, 2));
}

function loadPanelRef() {
    try { return JSON.parse(fs.readFileSync(PANEL_FILE, "utf8")); }
    catch { return null; }
}

function savePanelRef(channelId, messageId) {
    fs.writeFileSync(PANEL_FILE, JSON.stringify({ channelId, messageId }, null, 2));
}

function loadPanelContent() {
    try { const value = JSON.parse(fs.readFileSync(PANEL_CONTENT_FILE, "utf8")); return { title: typeof value.title === "string" ? value.title : "Spawner Buy & Sell", description: typeof value.description === "string" ? value.description : "" }; }
    catch { return { title: "Spawner Buy & Sell", description: "" }; }
}
function savePanelContent(content) { fs.writeFileSync(PANEL_CONTENT_FILE, JSON.stringify(content, null, 2)); }

function buildSpawnerPanel() {
    const stock = loadStock();
    const custom = loadPanelContent();
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(emojiText(EMOJIS.spawner) + " " + custom.title)
        .setDescription((custom.description || "Want to buy or sell a spawner? Open a private ticket and choose the spawner type, whether you're buying or selling, and your price.") + "\n\n**Available stock**\n" + emojiText(EMOJIS.ironGolem) + " Iron Golem: **" + stock.iron_golem.toLocaleString("en-US") + "**\n" + emojiText(EMOJIS.skeleton) + " Skeleton: **" + stock.skeleton.toLocaleString("en-US") + "**")
        .setFooter({ text: "AnchorFall • Spawner Market" });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("spawner_prices_open").setLabel("Buy / Sell Spawners").setEmoji(EMOJIS.spawner).setStyle(ButtonStyle.Success)
    );
    return { embeds: [embed], components: [row] };
}

async function updateSpawnerPanel(client) {
    const ref = loadPanelRef();
    if (!ref || !ref.channelId || !ref.messageId) {
        throw new Error("No saved Spawner Prices panel. Run /spawnerprices once to create and register it.");
    }
    const channel = await client.channels.fetch(ref.channelId);
    if (!channel || !channel.isTextBased()) throw new Error("Saved Spawner Prices channel is unavailable.");
    const message = await channel.messages.fetch(ref.messageId);
    await message.edit(buildSpawnerPanel());
}
const EMOJIS = {
    spawner: { id: "1558199899319959783", name: "spawner" },
    skeleton: { id: "1558199920304070697", name: "skeletonspawneremoji" },
    ironGolem: { id: "1558199935176810567", name: "irongolememoji" }
};
const emojiText = emoji => "<:" + emoji.name + ":" + emoji.id + ">";

const commands = [
    new SlashCommandBuilder()
        .setName("spawnerprices")
        .setDescription("Post the spawner buy/sell ticket panel"),
    new SlashCommandBuilder()
        .setName("editstock")
        .setDescription("Edit the available spawner stock")
        .addStringOption(option => option
            .setName("spawner")
            .setDescription("Which spawner's stock to edit")
            .setRequired(true)
            .addChoices(
                { name: "Iron Golem", value: "iron_golem" },
                { name: "Skeleton", value: "skeleton" }
            ))
        .addIntegerOption(option => option
            .setName("quantity")
            .setDescription("New stock quantity (use 0 for out of stock)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(1000000))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

async function createSpawnerTicket(interaction) {
    const parent = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID);
    if (!parent || parent.type !== ChannelType.GuildText) throw new Error("Ticket channel is missing or is not a text channel.");

    const activeThreads = await parent.threads.fetchActive();
    const existing = activeThreads.threads.find(thread =>
        thread.ownerId === interaction.user.id && thread.name.startsWith("ticket-spawner-prices-")
    );
    if (existing) return { thread: existing, existing: true };

    const thread = await parent.threads.create({
        name: ("ticket-spawner-prices-" + interaction.user.username).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: "Spawner listing opened by " + interaction.user.tag
    });
    await thread.members.add(interaction.user.id);

    const select = new StringSelectMenuBuilder()
        .setCustomId("spawner_listing_type")
        .setPlaceholder("Choose what you want to buy or sell")
        .addOptions(
            { label: "Sell Iron Golem Spawner", value: "sell_iron", description: "List an Iron Golem spawner for sale", emoji: EMOJIS.ironGolem },
            { label: "Buy Iron Golem Spawner", value: "buy_iron", description: "Say what you'll pay for an Iron Golem spawner", emoji: EMOJIS.ironGolem },
            { label: "Sell Skeleton Spawner", value: "sell_skeleton", description: "List a Skeleton spawner for sale", emoji: EMOJIS.skeleton },
            { label: "Buy Skeleton Spawner", value: "buy_skeleton", description: "Say what you'll pay for a Skeleton spawner", emoji: EMOJIS.skeleton }
        );

    await thread.send({
        content: "🎫 **Spawner Buy / Sell Ticket**\n\nHey <@" + interaction.user.id + ">! Choose what you're looking to do below. You'll then enter your price and quantity.\n\nPlease enter prices in **DonutSMP money ($)**.",
        components: [
            new ActionRowBuilder().addComponents(select),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger)
            )
        ]
    });
    return { thread, existing: false };
}

async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === "editstock") {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: "❌ You need Manage Server permission to edit spawner stock.", ephemeral: true });
            return true;
        }
        const type = interaction.options.getString("spawner", true);
        const quantity = interaction.options.getInteger("quantity", true);
        const stock = loadStock();
        stock[type] = quantity;
        try {
            saveStock(stock);
            await updateSpawnerPanel(interaction.client);
        } catch (error) {
            console.error("Could not save stock or update Spawner Prices panel:", error);
            await interaction.reply({
                content: "⚠️ Stock was saved, but I couldn't edit the existing **Spawner Prices** message. Run /spawnerprices once in the channel where the panel should live, then try /editstock again. Details: " + error.message,
                ephemeral: true
            });
            return true;
        }
        const label = type === "iron_golem" ? "Iron Golem" : "Skeleton";
        const emoji = type === "iron_golem" ? emojiText(EMOJIS.ironGolem) : emojiText(EMOJIS.skeleton);
        await interaction.reply({
            content: "✅ Updated the **existing Spawner Prices message**. " + emoji + " **" + label + " Spawner** stock is now **" + quantity.toLocaleString("en-US") + "**.",
            ephemeral: true
        });
        return true;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "spawnerprices") {
        const payload = buildSpawnerPanel();
        const ref = loadPanelRef();
        try {
            if (ref && ref.channelId && ref.messageId) {
                // Always edit the registered panel, even if /spawnerprices is run in another channel.
                const channel = await interaction.client.channels.fetch(ref.channelId);
                if (!channel || !channel.isTextBased()) throw new Error("Saved Spawner Prices channel is unavailable.");
                const message = await channel.messages.fetch(ref.messageId);
                await message.edit(payload);
                await interaction.reply({ content: "✅ Edited the existing Spawner Prices message.", ephemeral: true });
            } else {
                const message = await interaction.channel.send(payload);
                savePanelRef(interaction.channelId, message.id);
                await interaction.reply({ content: "✅ Spawner Prices message created and saved. Future /spawnerprices and /editstock runs will edit this message.", ephemeral: true });
            }
        } catch (error) {
            console.error("Could not post or update Spawner Prices panel:", error);
            await interaction.reply({ content: "❌ Couldn't create or update the Spawner Prices message. Check my channel permissions.", ephemeral: true });
        }
        return true;
    }

    if (interaction.isButton() && interaction.customId === "spawner_prices_open") {
        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await createSpawnerTicket(interaction);
            await interaction.editReply(result.existing
                ? "🎫 You already have an open spawner ticket: <#" + result.thread.id + ">"
                : "✅ Your private spawner ticket is open: <#" + result.thread.id + ">");
        } catch (error) {
            console.error("❌ Could not create spawner ticket:", error);
            await interaction.editReply("❌ I couldn't open your spawner ticket. Please tell staff.");
        }
        return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "spawner_listing_type") {
        const choices = {
            sell_iron: { action: "SELL", spawner: "Iron Golem Spawner" },
            buy_iron: { action: "BUY", spawner: "Iron Golem Spawner" },
            sell_skeleton: { action: "SELL", spawner: "Skeleton Spawner" },
            buy_skeleton: { action: "BUY", spawner: "Skeleton Spawner" }
        };
        const key = interaction.values[0];
        const choice = choices[key];
        if (!choice) {
            await interaction.reply({ content: "❌ That listing option is invalid.", ephemeral: true });
            return true;
        }

        const modal = new ModalBuilder()
            .setCustomId("spawner_price_modal:" + key)
            .setTitle(choice.action + " " + choice.spawner.replace(" Spawner", ""));
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("price").setLabel("Price per spawner ($)").setPlaceholder("e.g. 6000000").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("quantity").setLabel("How many spawners?").setPlaceholder("e.g. 1").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("notes").setLabel("Extra details (optional)").setPlaceholder("e.g. negotiable, bulk deal").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(150)
            )
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("spawner_price_modal:")) {
        const key = interaction.customId.split(":")[1];
        const choices = {
            sell_iron: { action: "SELLING", spawner: "Iron Golem Spawner", emoji: emojiText(EMOJIS.ironGolem) },
            buy_iron: { action: "BUYING", spawner: "Iron Golem Spawner", emoji: emojiText(EMOJIS.ironGolem) },
            sell_skeleton: { action: "SELLING", spawner: "Skeleton Spawner", emoji: emojiText(EMOJIS.skeleton) },
            buy_skeleton: { action: "BUYING", spawner: "Skeleton Spawner", emoji: emojiText(EMOJIS.skeleton) }
        };
        const choice = choices[key];
        if (!choice) {
            await interaction.reply({ content: "❌ That listing option is invalid.", ephemeral: true });
            return true;
        }

        const rawPrice = interaction.fields.getTextInputValue("price").trim().replace(/[$,\s]/g, "");
        const rawQuantity = interaction.fields.getTextInputValue("quantity").trim();
        const price = Number(rawPrice);
        const quantity = Number(rawQuantity);
        const notes = interaction.fields.getTextInputValue("notes").trim();

        if (!/^\d+$/.test(rawPrice) || !Number.isSafeInteger(price) || price < 1 || price > 1000000000000) {
            await interaction.reply({ content: "❌ Enter a valid whole-number price, e.g. `6000000`.", ephemeral: true });
            return true;
        }
        if (!/^\d+$/.test(rawQuantity) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
            await interaction.reply({ content: "❌ Quantity must be a whole number from 1 to 999.", ephemeral: true });
            return true;
        }

        const embed = new EmbedBuilder()
            .setColor(choice.action === "SELLING" ? 0x2ECC71 : 0x3498DB)
            .setTitle(choice.emoji + " " + choice.spawner + " " + choice.action + " Listing")
            .addFields(
                { name: "Member", value: "<@" + interaction.user.id + ">", inline: true },
                { name: "Spawner", value: choice.spawner, inline: true },
                { name: "Type", value: choice.action, inline: true },
                { name: "Price each", value: "$" + price.toLocaleString("en-US"), inline: true },
                { name: "Quantity", value: String(quantity), inline: true },
                { name: "Total", value: "$" + (price * quantity).toLocaleString("en-US"), inline: true }
            )
            .setTimestamp(new Date());
        if (notes) embed.addFields({ name: "Extra details", value: notes });

        await interaction.reply({ content: "✅ Your listing details have been added to this ticket.", embeds: [embed] });
        if (interaction.channel && interaction.channel.isThread()) {
            await interaction.channel.send("📌 Listing submitted by <@" + interaction.user.id + ">. Staff can help coordinate the trade; confirm all terms before trading.");
        }
        return true;
    }

    return false;
}

module.exports = { commands, handleInteraction, updateSpawnerPanel, loadPanelContent, savePanelContent };
