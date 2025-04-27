import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import winston from "winston";

dotenv.config();

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

const app = express();
app.use(cors());
app.use(express.json());

const activeConnections = new Map();
const taskResults = new Map();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL || "http://localhost:8000/sse";

app.get("/sse", async (req, res) => {
  const taskId = req.query.taskId;
  if (!taskId) {
    return res.status(400).json({ error: "Task ID is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const response = await fetch(MCP_SERVER_URL, {
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to connect to MCP server: ${response.statusText}`,
      );
    }

    const connectionId = Date.now().toString();
    activeConnections.set(connectionId, { res, taskId });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const events = chunk.split("\n\n").filter(Boolean);

      for (const event of events) {
        if (event.startsWith("data:")) {
          const data = event.slice(5).trim();
          try {
            const eventData = JSON.parse(data);

            if (WEBHOOK_URL) {
              try {
                await fetch(WEBHOOK_URL, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    event: eventData,
                    connectionId,
                    taskId,
                    timestamp: new Date().toISOString(),
                  }),
                });
              } catch (error) {
                logger.error("Failed to forward event to webhook:", error);
              }
            }

            if (
              eventData.method === "notifications/message" &&
              eventData.params?.data?.result?.done === true
            ) {
              taskResults.set(taskId, {
                status: "completed",
                result: eventData.params.data.result,
                timestamp: new Date().toISOString(),
              });
            }

            res.write(`data: ${data}\n\n`);
          } catch (error) {
            logger.error("Failed to parse event data:", error);
          }
        }
      }
    }
  } catch (error) {
    logger.error("SSE connection error:", error);
    res.status(500).json({ error: "Failed to establish SSE connection" });
  } finally {
    activeConnections.delete(connectionId);
    res.end();
  }
});

app.post("/api/perform", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  const taskId = Date.now().toString();

  try {
    const response = await fetch(
      `http://localhost:${process.env.PORT || 3000}/sse?taskId=${taskId}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to start SSE connection: ${response.statusText}`);
    }

    const mcpResponse = await fetch(`${MCP_SERVER_URL}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: "perform_search",
        params: {
          task: message,
        },
      }),
    });

    if (!mcpResponse.ok) {
      throw new Error(
        `Failed to send message to MCP server: ${mcpResponse.statusText}`,
      );
    }

    const checkTaskStatus = async () => {
      const result = taskResults.get(taskId);
      if (result) {
        taskResults.delete(taskId);
        return result;
      }
      return null;
    };

    const pollInterval = setInterval(async () => {
      const result = await checkTaskStatus();
      if (result) {
        clearInterval(pollInterval);
        res.json(result);
      }
    }, 1000);

    setTimeout(() => {
      clearInterval(pollInterval);
      if (!taskResults.has(taskId)) {
        res.status(408).json({ error: "Task timeout" });
      }
    }, 300000);
  } catch (error) {
    logger.error("Failed to perform action:", error);
    res.status(500).json({ error: "Failed to perform action" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connections: activeConnections.size,
    pendingTasks: taskResults.size,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
