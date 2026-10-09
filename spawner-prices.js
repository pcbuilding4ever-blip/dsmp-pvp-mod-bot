const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, ChannelType
} = require("discord.js");

const TICKET_CHANNEL_ID = "1553777212170178570";

const commands = [
    new SlashCommandBuilder()
        .setName("spawnerprices")
        .setDescription("Post the spawner buy/sell ticket panel")
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
            { label: "Sell Iron Golem Spawner", value: "sell_iron", description: "List an Iron Golem spawner for sale", emoji: "🟠" },
            { label: "Buy Iron Golem Spawner", value: "buy_iron", description: "Say what you'll pay for an Iron Golem spawner", emoji: "🟠" },
            { label: "Sell Skeleton Spawner", value: "sell_skeleton", description: "List a Skeleton spawner for sale", emoji: "💀" },
            { label: "Buy Skeleton Spawner", value: "buy_skeleton", description: "Say what you'll pay for a Skeleton spawner", emoji: "💀" }
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
    if (interaction.isChatInputCommand() && interaction.commandName === "spawnerprices") {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("💰 Spawner Buy & Sell")
            .setDescription("Want to buy or sell a spawner? Open a private ticket and choose the spawner type, whether you're buying or selling, and your price.\n\n**Supported spawners**\n🟠 Iron Golem\n💀 Skeleton\n\nPrices are set by you — this panel does not use an unreliable market average.")
            .setFooter({ text: "DSMP PvP • Spawner Market" });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("spawner_prices_open").setLabel("Buy / Sell Spawners").setEmoji("💰").setStyle(ButtonStyle.Success)
        );
        await interaction.reply({ embeds: [embed], components: [row] });
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
            sell_iron: { action: "SELLING", spawner: "Iron Golem Spawner", emoji: "🟠" },
            buy_iron: { action: "BUYING", spawner: "Iron Golem Spawner", emoji: "🟠" },
            sell_skeleton: { action: "SELLING", spawner: "Skeleton Spawner", emoji: "💀" },
            buy_skeleton: { action: "BUYING", spawner: "Skeleton Spawner", emoji: "💀" }
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
            .setTitle(choice.emoji + " Spawner " + choice.action + " Listing")
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

module.exports = { commands, handleInteraction };
