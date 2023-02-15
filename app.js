// Include the cluster module
var cluster = require("cluster");

// Code to run if we're in the master process
if (cluster.isMaster) {
  // Count the machine's CPUs
  var cpuCount = require("os").cpus().length;

  // Create a worker for each CPU
  for (var i = 0; i < cpuCount; i += 1) {
    cluster.fork();
  }

  // Listen for terminating workers
  cluster.on("exit", function (worker) {
    // Replace the terminated workers
    console.log("Worker " + worker.id + " died :(");
    cluster.fork();
  });

  // Code to run if we're in a worker process
} else {
  // Include the AWS X-Ray Node.js SDK and set configuration
  var XRay = require("aws-xray-sdk");
  var AWS = XRay.captureAWS(require("aws-sdk"));
  var http = XRay.captureHTTPs(require("http"));
  var express = require("express");
  var bodyParser = require("body-parser");
  var queryString = require("querystring");

  AWS.config.region = process.env.REGION;

  XRay.config([XRay.plugins.EC2Plugin, XRay.plugins.ElasticBeanstalkPlugin]);
  XRay.middleware.setSamplingRules("sampling-rules.json");
  XRay.middleware.enableDynamicNaming();

  var app = express();
  var sns = new AWS.SNS();
  var ddb = new AWS.DynamoDB();
  var ddbTable = process.env.FIREBASE_USER_MAP_TABLE;
  var snsTopic = process.env.FIREBASE_USER_MAP_TOPIC;
  var apiCNAME = process.env.API_CNAME || "localhost";

  app.set("view engine", "ejs");
  app.set("views", __dirname + "/views");
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(XRay.express.openSegment("myfrontend"));

  app.get("/", function (req, res) {
    XRay.captureAsyncFunc("Root get", function (seg) {
      res.send("Hello World");
      seg.close();
    });

    res.status(200).end();
  });

  app.post("/user", function (req, res) {
    var item = {
      id: { S: req.body.id },
      firebase_id: { S: req.body.firebase_id },
    };

    var seg = XRay.getSegment();
    seg.addAnnotation("firebase_id", req.body.firebase_id);

    ddb.putItem(
      {
        TableName: ddbTable,
        Item: item,
        Expected: { email: { Exists: false } },
      },
      function (err, data) {
        if (err) {
          if (err.code === "ConditionalCheckFailedException") {
            res.status(409).end("User already exists");
          } else {
            res.status(500).end("DDB Error");
          }
        } else {
          sns.publish(
            {
              Message:
                "id: " + req.body.id + " firebase_id: " + req.body.firebase_id,
              Subject: "New user sign up!!!",
              TopicArn: snsTopic,
            },
            function (err, data) {
              if (err) {
                res.status(500).end("SNS Error");
              } else {
                res.status(201).end("Success");
              }
            }
          );
        }
      }
    );
  });

  app.use(XRay.express.closeSegment());

  var port = process.env.PORT || 3000;

  var server = app.listen(port, function () {
    console.log("Server running at http://127.0.0.1:" + port + "/");
  });
}
