using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using Amazon.IotData;
using Amazon.Lambda;
using Amazon.Lambda.Model;
using Amazon.Lambda.Core;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Serialization.Json;
using System.Text;
using System.Collections;
using Amazon.IotData.Model;
using System.IO;
using System.Threading;
using System.Net.Http;

// Assembly attribute to enable the Lambda function's JSON input to be converted into a .NET class.
[assembly: LambdaSerializerAttribute(typeof(Amazon.Lambda.Serialization.Json.JsonSerializer))]
namespace Graybox
{
    public class Functions
    {
        private static HttpClient httpClient;
        /// <summary>
        /// Default constructor that Lambda will invoke.
        /// </summary>
        public Functions()
        {
            httpClient = new HttpClient();
        }


        /// <summary>
        /// A Lambda function to respond to HTTP Get methods from API Gateway
        /// </summary>
        /// <param name="request"></param>
        /// <returns>The list of blogs</returns>
        public async Task<APIGatewayProxyResponse> Get(FunctionRequest request, ILambdaContext context)
        {
            context.Logger.LogLine("first line of function:" + context.FunctionName);

            if(!request.QueryStringParameters.ContainsKey("token") || System.Environment.GetEnvironmentVariable("SlackKey") != request.QueryStringParameters["token"])
            {
                context.Logger.LogLine("forbidden" );
                return new APIGatewayProxyResponse
                {
                    StatusCode = (int)HttpStatusCode.Forbidden,
                    Headers = new Dictionary<string, string> { { "Content-Type", "text/plain" } }
                };
            }

            if(request.QueryStringParameters.ContainsKey("reinvoke"))
            {
                await HandleReinvokeRequest(request.QueryStringParameters, context);
                return new APIGatewayProxyResponse
                {
                    StatusCode = (int)HttpStatusCode.OK,
                    Body = "",
                    Headers = new Dictionary<string, string> { { "Content-Type", "text/plain" } }
                };  
            }
            var commandText = request.QueryStringParameters["text"];

            //split command
            var commandPieces = commandText.Split(' ');
            if(commandPieces.Length < 2)
            {
                return new APIGatewayProxyResponse
                {
                    StatusCode = (int)HttpStatusCode.NotAcceptable,
                    Body = "Invalid command passed in",
                    Headers = new Dictionary<string, string> { { "Content-Type", "text/plain" } }
                };      
            }


            await ReinvokeLambda(request, context.FunctionName);


            var response = new APIGatewayProxyResponse
            {
                StatusCode = (int)HttpStatusCode.OK,
                Body = "Request has been successfully sent",
                Headers = new Dictionary<string, string> { { "Content-Type", "text/plain" } }
            };

            return response;
        }

        private async Task ReinvokeLambda(FunctionRequest request, string functionName)
        {
            // we know we are validated and good to go - so return that the command is running
            // invoke the lambda again so it can run longer than 3s
            // and return
            request.QueryStringParameters.Add("reinvoke","true");

            var serializer = new JsonSerializer();
            var lambdaClient = new AmazonLambdaClient();
            var memStream = new MemoryStream();
            serializer.Serialize(request, memStream);
            memStream.Position = 0;
            await lambdaClient.InvokeAsync(new InvokeRequest()
            {
                FunctionName = functionName,
                PayloadStream = memStream,
                InvocationType = InvocationType.Event,
            });

        }

        private async Task HandleReinvokeRequest(IDictionary<string,string> queryStringParameters, ILambdaContext context)
        {
            var username = queryStringParameters["user_name"];
            var commandText = queryStringParameters["text"];
            var responseUrl = queryStringParameters["response_url"];

            //split command
            var commandPieces = commandText.Split(' ');
            context.Logger.LogLine("username: " + username);
            context.Logger.LogLine("commandText: " + commandText);

            var boxId = commandPieces[0];
            var command = commandPieces[1].ToLowerInvariant();

            context.Logger.LogLine("boxId: " + boxId);

            // get device endpoint
            var serviceEndpoint = await GetIotEndpoint();

            string result = "";
            switch(command)
            {
                case "get-device-state":
                {
                    result = await GetDeviceState(serviceEndpoint, boxId);
                    break;
                }
            }
            await SendResultToSlack(responseUrl, result);
        }

        private async Task<string> GetIotEndpoint() 
        {
            var client = new Amazon.IoT.AmazonIoTClient();
            var t = await client.DescribeEndpointAsync();
            return t.EndpointAddress;
        }
        private async Task<string> GetDeviceState(string serviceEndpoint, string boxId)
        {
            AmazonIotDataClient client = new AmazonIotDataClient("https://"+serviceEndpoint);
            var result = await client.GetThingShadowAsync(new GetThingShadowRequest()
            {
                ThingName = boxId
            });
            JsonSerializer s = new JsonSerializer();

            var state = s.Deserialize<GrayboxDeviceState>(result.Payload);
            var desired = state.state.desired;

            StringBuilder str = new StringBuilder();
            str.AppendLine();
            str.AppendLine("Device State: " + boxId);
            str.AppendLine("==========================");
            str.AppendLine("cameraIp: " + desired.cameraIp);
            str.AppendLine("cameraPort: " + desired.cameraPort);
            str.AppendLine("encoderEnabled: " + desired.encoderEnabled.ToString());
            str.AppendLine("rtmpStreamPath: " + desired.rtmpStreamPath);
            str.AppendLine("localCameraProxy: " + desired.localCameraProxy);
            str.AppendLine();
            
            return str.ToString();
        }

        private async Task SendResultToSlack(string responseUrl, string result)
        {
            var serializer = new JsonSerializer();
            using(var memStream = new MemoryStream())
            {
                var response = new SlackResponse()
                {
                    response_type = "ephemeral",
                    text = result
                };
                serializer.Serialize(response, memStream);
                memStream.Position = 0;
                using(var str = new StreamReader(memStream))
                {
                    var stringResult = await str.ReadToEndAsync();
                    StringContent sc = new StringContent(stringResult, Encoding.UTF8, "application/json");
                    await httpClient.PostAsync(responseUrl, sc);
                }
           
            }
        }
    }

    internal class GrayboxDeviceState
    {
        public InternalState state {get;set;}
    }
    internal class InternalState
    {
        public DesiredStateObject desired {get;set;}
    }
    internal class DesiredStateObject 
    {
        public bool encoderEnabled {get;set;}
        public string cameraIp {get;set;}
        public string cameraPort {get;set;}
        public string rtmpStreamPath {get;set;}
        public bool localCameraProxy {get;set;}

    }

    public class FunctionRequest
    {
        public IDictionary<string, string> QueryStringParameters {get;set;}
    }
    public class SlackResponse
    {
        public string response_type {get;set;}
        public string text {get;set;}
    }

}
