import express from "express";
import cors from "cors";
const server = express();
import path from "path";
import cookieParser from "cookie-parser";
import errorRouter from "./controllers/error.controller.js";
import mongoSanitize from "express-mongo-sanitize";
import { xss } from "express-xss-sanitizer";
import helmet from "helmet";
import hpp from "hpp";

// middlewares
server.use(cors());
server.use(express.json());
server.use(cookieParser());
// server.use(express.static(path.resolve(__dirname, process.env.PUBLIC_DIR)));
server.use(mongoSanitize());
server.use(xss());
server.use(helmet());

// parameter white listing
server.use(
  hpp({
    whitelist: ["date", "fromDate"],
  })
);

// importing routes
import farmerRoute from "./routes/farmer.route.js";
import orderRoute from "./routes/order.route.js";
import userRoute from "./routes/user.route.js";
import cmsRoute from "./routes/cms.route.js";
import employeeRoute from "./routes/employee.route.js";
import attendanceRoute from "./routes/attendance.route.js";
import reportingRoute from "./routes/reporting.route.js";
import labRoute from "./routes/lab.route.js";
import primaryHardeingRoute from "./routes/primaryHardening.route.js";
import secondaryHardeingRoute from "./routes/secondaryHardening.route.js";
import godownRoute from "./routes/godown.route.js";
import seedRoute from "./routes/seed.route.js";
import vegetableRoute from "./routes/vegetable.route.js";
import chemicalRoute from "./routes/chemical.route.js";

// defining routes
server.use("/api/v1/farmer", farmerRoute);
server.use("/api/v1/order", orderRoute);
server.use("/api/v1/user", userRoute);
server.use("/api/v1/cms", cmsRoute);
server.use("/api/v1/employee", employeeRoute);
server.use("/api/v1/attendance", attendanceRoute);
server.use("/api/v1/reporting", reportingRoute);
server.use("/api/v1/lab", labRoute);
server.use("/api/v1/primaryHardeingRoute", primaryHardeingRoute);
server.use("/api/v1/secondaryHardeingRoute", secondaryHardeingRoute);
server.use("/api/v1/godown", godownRoute);
server.use("/api/v1/seed", seedRoute);
server.use("/api/v1/vegetable", vegetableRoute);
server.use("/api/v1/chemical", chemicalRoute);

server.use(errorRouter);

export default server;
