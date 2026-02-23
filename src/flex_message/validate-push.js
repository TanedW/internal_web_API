// src/flex_message/validate-push.js

const validatePushHandler = async (req, res) => {
  try {
    // ใน Express.js ใช้ req.body ได้เลย
    const flexContents = req.body;

    if (!flexContents || Object.keys(flexContents).length === 0) {
      return res.status(400).json({
        error: "Missing flex message contents in request body",
      });
    }

    const payload = {
      to: "U00000000000000000000000000000000",
      messages: [
        {
          type: "flex",
          altText: "Preview",
          contents: flexContents,
        },
      ],
    };

    console.log("Token being used:", process.env.LINE_CHANNEL_ACCESS_TOKEN);

    const lineRes = await fetch(
      "https://api.line.me/v2/bot/message/validate/push",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(payload),
      }
    );

    const result = await lineRes.json();

    if (!lineRes.ok) {
      return res.status(lineRes.status).json(result);
    }	

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Validate Push Error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
    });
  }
};

// การทำแบบนี้จะการันตีว่ามี default export ออกไปแน่นอน
export default validatePushHandler;
