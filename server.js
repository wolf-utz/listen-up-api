require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const path = require("path");
const fs = require("fs").promises;

const app = express();
const port = process.env.PORT || 3001;

// Ensure public/audios directory exists
const ensureAudiosDir = async () => {
  const audiosDir = path.join(__dirname, "public", "audios");
  try {
    await fs.mkdir(audiosDir, { recursive: true });
  } catch (err) {
    console.error("Error creating audios directory:", err);
  }
};

// Initialize directory on startup
ensureAudiosDir();

// // CORS configuration
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// Apply CORS to all routes
app.use(cors(corsOptions));

app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Serve static files from the 'public' directory
app.use(express.static("public"));

// Generate story and audio endpoint
app.post("/api/generate-story", async (req, res) => {
  try {
    const { topic, answerType } = req.body;

    if (process.env.USE_MOCK_DATA === "1") {
      let mockData = require("./mockdata/response.json");

      if (answerType === "multiple") {
        mockData = require("./mockdata/response_multiple_choice.json");
      }

      return res.json(mockData);
    }

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    // Read the prompt template
    const promptTemplate = await fs.readFile(
      path.join(__dirname, "prompts", "createStoryAndQuestions.txt"),
      "utf-8"
    );

    // Replace the topic placeholder
    const prompt = promptTemplate.replace("$TOPIC", topic);

    // Generate story using OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.TEXT_MODEL || "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that creates German learning materials.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const result = JSON.parse(content);
    const { requestId, story } = result;

    if (!requestId || !story) {
      throw new Error("Invalid response format from OpenAI");
    }

    if (story.length > 500) {
      throw new Error("Story is too long");
    }

    // Generate audio for the story
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: process.env.VOICE || "nova",
      input: story,
    });

    const audioBuffer = Buffer.from(await mp3.arrayBuffer());
    const audioFileName = `${requestId}.mp3`;
    const audioFilePath = path.join("public", "audios", audioFileName);

    // Save audio file
    await fs.writeFile(audioFilePath, audioBuffer);

    // Prepare response
    const response = {
      ...result,
      audioUrl: `/audios/${audioFileName}`,
    };

    res.json(response);
  } catch (error) {
    console.error("Error generating story:", error);
    res.status(500).json({
      error: "Failed to generate story",
      details: error.message,
    });
  }
});

// Evaluate answers endpoint
app.post("/api/evaluate-answers", async (req, res) => {
  try {
    const { story, questions } = req.body;

    // Validate request
    if (!story || !Array.isArray(questions)) {
      return res.status(400).json({
        error:
          "Invalid request format. Expected { story: string, questions: Array }",
      });
    }

    // Read the evaluation prompt template
    const evaluationPromptTemplate = await fs.readFile(
      path.join(__dirname, "prompts", "evaluateAnswers.txt"),
      "utf-8"
    );

    // Format questions and answers
    const formattedQuestions = questions
      .map(
        (q, i) =>
          `${i + 1}. Question: ${q.question}\n   Answer: ${
            q.answer || "No answer provided"
          }`
      )
      .join("\n\n");

    // Replace placeholders in the template
    const evaluationPrompt = evaluationPromptTemplate
      .replace("$STORY", story)
      .replace("$QUESTIONS", formattedQuestions);

    // Get evaluation from OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.TEXT_MODEL || "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful German language teacher. Evaluate the answers based on the story and questions. Always respond in the specified JSON format.",
        },
        { role: "user", content: evaluationPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No evaluation content received from OpenAI");
    }

    // Parse and return the evaluation
    const evaluation = JSON.parse(content);
    res.json(evaluation);
  } catch (error) {
    console.error("Error evaluating answers:", error);
    res.status(500).json({
      error: "Failed to evaluate answers",
      details: error.message,
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

module.exports = app;
