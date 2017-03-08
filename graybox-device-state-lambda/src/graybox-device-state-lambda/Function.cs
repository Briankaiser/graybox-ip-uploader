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

            if(string.IsNullOrWhiteSpace(commandText) || commandText.ToLowerInvariant().Equals("help"))
            {
                return GenerateHelpText();
            }

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
                Body = "_Okay!_",
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

            var boxId = commandPieces[0];
            var command = commandPieces[1].ToLowerInvariant();

            // get device endpoint
            var serviceEndpoint = await GetIotEndpoint();

            string result = "";
            switch(command)
            {
                case "get-device-state":
                case "get":
                {
                    result = await GetDeviceState(serviceEndpoint, boxId);
                    break;
                }
                case "set-device-state":
                case "set":
                {
                    result = await SetDeviceState(serviceEndpoint, boxId, commandText, context);
                    break;
                }
                case "add-scheduled-recording":
                case "asr":
                {
                    result = await AddScheduledRecording(serviceEndpoint, boxId, commandText, context);
                    break;
                }
                case "remove-scheduled-recording":
                case "rsr":
                {
                    result = await RemoveScheduledRecording(serviceEndpoint, boxId, commandText, context);
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
        
        private async Task<string> RemoveScheduledRecording(string serviceEndpoint, string boxId, string commandText, ILambdaContext context)
        {
            //validate input {boxId} {command} {recording-number}
            var splitCommand = commandText.Split(' ');
            if(splitCommand.Length != 3)
            {
                return "Bad remove scheduled recording command. Invalid number of arguments found: " + splitCommand.Length;
            }
            var removeNumStr = splitCommand[2];
            int removeNum;
            if(!int.TryParse(removeNumStr, out removeNum))
            {
                 return "Bad add scheduled recording command. Invalid recording number passed in: " + removeNumStr;               
            }
            removeNum = removeNum - 1; //convert to array index
            if(removeNum < 0)
            {

            }

            var shadow = await GetThingShadow(serviceEndpoint, boxId);
            var existingScheduled = shadow.state.desired.scheduledRecordings;
            if(existingScheduled == null)
            {
                existingScheduled = new List<ScheduledRecording>();
            }
            if(removeNum < 0 || removeNum > existingScheduled.Count-1)
            {
                return "Bad add scheduled recording command. Out of range recording number passed in: " + removeNumStr;                
            }

            existingScheduled.RemoveAt(removeNum);

            //write it back

            //generate string for the array
            var strbld = new StringBuilder();
            strbld.Append("[");
            bool isFirst = true;
            foreach(var sr in existingScheduled)
            {
                if(!isFirst)
                {
                    strbld.Append(",");                   
                }
                strbld.Append("{");
                strbld.Append("\"startDate\":");
                strbld.AppendFormat("\"{0}\"", sr.startDate);
                strbld.Append(",");
                strbld.Append("\"endDate\":");
                strbld.AppendFormat("\"{0}\"", sr.endDate);
                strbld.Append("}");
                isFirst = false;
            }
            strbld.Append("]");

            await SendUpdateThingCommand(serviceEndpoint, boxId, "scheduledRecordings", strbld.ToString());

            return "Schedule entry successfully removed at recording index: " + removeNumStr;
        }
        private async Task<string> AddScheduledRecording(string serviceEndpoint, string boxId, string commandText, ILambdaContext context)
        {
            //validate input {boxId} {command} {startDate} {endDate}
            var splitCommand = commandText.Split(' ');
            if(splitCommand.Length != 4)
            {
                return "Bad add scheduled recording command. Invalid number of arguments found: " + splitCommand.Length;
            }
            var startDateStr = splitCommand[2];
            var endDateStr = splitCommand[3];
            DateTime startDate, endDate;

            if(!DateTime.TryParse(startDateStr, out startDate))
            {
                return "Bad add scheduled recording command. Invalid start date: " + startDateStr;
            }
            
            if(!DateTime.TryParse(endDateStr, out endDate))
            {
                return "Bad add scheduled recording command. Invalid end date: " + endDateStr;
            }
            startDate = startDate.ToUniversalTime();
            endDate = endDate.ToUniversalTime();

            if( startDate > endDate) 
            {
                  return "Bad add scheduled recording command. Start Date can not come after End Date";              
            }

            //return "Adding schedule entry with \nstartdate: " + startDate.ToString("u") + "\nenddate: " + endDate.ToString("u");

            // we need to get the current schedule list from the shadow
            // then add this item to the list and Set

            var shadow = await GetThingShadow(serviceEndpoint, boxId);
            var existingScheduled = shadow.state.desired.scheduledRecordings;
            if(existingScheduled == null)
            {
                existingScheduled = new List<ScheduledRecording>();
            }
            existingScheduled.Add(new ScheduledRecording()
            {
                startDate = startDate.ToString("u"),
                endDate = endDate.ToString("u")
            });
            //write it back

            //generate string for the array
            var strbld = new StringBuilder();
            strbld.Append("[");
            bool isFirst = true;
            foreach(var sr in existingScheduled)
            {
                if(!isFirst)
                {
                    strbld.Append(",");                   
                }
                strbld.Append("{");
                strbld.Append("\"startDate\":");
                strbld.AppendFormat("\"{0}\"", sr.startDate);
                strbld.Append(",");
                strbld.Append("\"endDate\":");
                strbld.AppendFormat("\"{0}\"", sr.endDate);
                strbld.Append("}");
                isFirst = false;
            }
            strbld.Append("]");

            await SendUpdateThingCommand(serviceEndpoint, boxId, "scheduledRecordings", strbld.ToString());

            return "Schedule entry successfully added. \nStart Date: " + startDate.ToString("u") + "\nEnd Date: " + endDate.ToString("u");
        }
        private async Task<string> SetDeviceState(string serviceEndpoint, string boxId, string commandText, ILambdaContext context)
        {
            //validate input {boxId} {command} {parameter} {value}
            var splitCommand = commandText.Split(' ');
            if(splitCommand.Length < 4)
            {
                return "Invalid set command. Too few arguments";
            }
            var parameter = splitCommand[2];
            if(!IsValidSetStateParameter(parameter))
            {
                return "Invalid set command. Invalid parameter: " + parameter;             
            }
            var value = string.Join(" ", splitCommand.Skip(3));

            if(!IsValidParameterValue(value))
            {
                return "Invalid set command. Value must be boolean, int, or string. If string - then in quotes. Value: " + value;
            }

            await SendUpdateThingCommand(serviceEndpoint, boxId, parameter, value);
            return "*Update successful. " + parameter + " : " + value + "*";
        }

        private async Task SendUpdateThingCommand(string serviceEndpoint, string boxId, string parameter, string value)
        {
            // NOTE: at this point inputs are assumed validated
            var str = new StringBuilder();
            str.AppendLine("{");
            str.AppendLine("  \"state\": {");
            str.AppendLine("    \"desired\": {");
            str.AppendLine("      \"" + parameter + "\": " + value);
            str.AppendLine("    }");
            str.AppendLine("  }");
            str.AppendLine("}");

            var jsonRequest = str.ToString();

            var client = new AmazonIotDataClient("https://" + serviceEndpoint);
            using(var memStream = new MemoryStream())
            {
                using(StreamWriter wr = new StreamWriter(memStream))
                {
                    wr.Write(jsonRequest);
                    wr.Flush();
                    memStream.Position = 0;
                    await client.UpdateThingShadowAsync(new UpdateThingShadowRequest()
                    {
                        ThingName = boxId,
                        Payload = memStream,
                    });
                }

            }

        }

        private async Task<string> GetDeviceState(string serviceEndpoint, string boxId)
        {
            var state = await GetThingShadow(serviceEndpoint, boxId);
            var desired = state.state.desired;
            var reported = state.state.reported;
            var metadata = state.metadata;

            DateTime lastUpdate = DateTime.MinValue;
            if(metadata.reported != null && metadata.reported.loadAverage != null)
            {
                lastUpdate = DateTimeOffset.FromUnixTimeSeconds(metadata.reported.loadAverage.timestamp).UtcDateTime;
            }
            
            StringBuilder str = new StringBuilder();
            str.AppendLine();
            str.AppendLine("*Device State (adjustable): " + boxId + "*");
            str.AppendLine("---------------------------");
            str.AppendLine("• cameraIp: \"" + desired.cameraIp + "\"");
            str.AppendLine("• cameraPort: \"" + desired.cameraPort + "\"");
            str.AppendLine("• encoderEnabled: " + desired.encoderEnabled);
            str.AppendLine("• rtmpStreamPath: \"" + desired.rtmpStreamPath + "\"");
            str.AppendLine("• localCameraProxy: " + desired.localCameraProxy);
            str.AppendLine("• audioFromCameraEnabled: " + desired.audioFromCameraEnabled);    
            str.AppendLine("• forceRtspTcp: " + desired.forceRtspTcp);          
            str.AppendLine("• snapshotEnabled: " + desired.snapshotEnabled);
            str.AppendLine("• snapshotPort: \"" + desired.snapshotPort + "\"");
            str.AppendLine("• snapshotPath: \"" + desired.snapshotPath + "\"");
            str.AppendLine("• ngrokEnabled: " + desired.ngrokEnabled);
            str.AppendLine("• ngrokAuthtoken: \"" + desired.ngrokAuthtoken + "\"");
            str.AppendLine("• firewallEnabled: " + desired.firewallEnabled);
            str.AppendLine("• scheduledRecordings: " + ((desired.scheduledRecordings == null || desired.scheduledRecordings.Count == 0) ? "none":""));
            if(desired.scheduledRecordings != null)
            {
                for(int i=0; i<desired.scheduledRecordings.Count; i++)
                {
                    str.AppendLine("    " + (i+1) + ". startDate: " +  desired.scheduledRecordings[i].startDate + ", endDate: " + desired.scheduledRecordings[i].endDate);
                }
            }
            str.AppendLine();
            str.AppendLine("*Device Status (reported): " + boxId + "*");
            str.AppendLine("---------------------------");
            str.AppendLine("• deviceId: \"" + reported.deviceId + "\"");
            str.AppendLine("• ffmpegRunning: " + reported.ffmpegRunning);
            str.AppendLine("• isUploaderRunning: " + reported.isUploaderRunning);
            str.AppendLine("• iotConnected: " + reported.iotConnected);    
            str.AppendLine("• cameraPing: " + reported.cameraPing);        
            str.AppendLine("• filesPendingUpload: " + reported.filesPendingUpload);
            str.AppendLine("• oldestFileName: \"" + reported.oldestFileName + "\"");
            str.AppendLine("• newestFileName: \"" + reported.newestFileName + "\"");
            str.AppendLine("• lastUploadDurationSec: " + reported.lastUploadDurationSec);
            str.AppendLine("• lastUploadSpeedMBps: " + reported.lastUploadSpeedMBps);
            str.AppendLine("• internalIps: \"" + reported.internalIps + "\"");
            str.AppendLine("• externalIp: \"" + reported.externalIp + "\"");
            str.AppendLine("• freeMemory: " + reported.freeMemory);
            str.AppendLine("• loadAverage: \"" + reported.loadAverage + "\"");
            str.AppendLine("• diskPercentInUse: \"" + reported.diskPercentInUse + "\"");
            str.AppendLine("• lastSnapshotUrl: \"" + reported.lastSnapshotUrl + "\"");
            str.AppendLine("• isNgrokRunning: " + reported.isNgrokRunning);  
            str.AppendLine("• ngrokSshAddress: \"" + reported.ngrokSshAddress + "\"");
            str.AppendLine();
            str.AppendLine("> _Last Update: " + lastUpdate.ToString("u") +  "_");
            str.AppendLine();           
            return str.ToString();
        }

        private async Task<GrayboxDeviceState> GetThingShadow(string serviceEndpoint, string boxId)
        {
            var client = new AmazonIotDataClient("https://" + serviceEndpoint);
            var result = await client.GetThingShadowAsync(new GetThingShadowRequest()
            {
                ThingName = boxId
            });

            // if(debug == true) 
            // {
            //     using(StreamReader rdr = new StreamReader(result.Payload))
            //     {
            //         return await rdr.ReadToEndAsync();
            //     }
            // }
            JsonSerializer s = new JsonSerializer();

            var state = s.Deserialize<GrayboxDeviceState>(result.Payload);
            var desired = state.state.desired;
            if(desired == null) desired = new DesiredStateObject();
            var reported = state.state.reported;
            if(reported == null) reported = new ReportedStateObject();
            var metadata = state.metadata;
            if(metadata == null) metadata = new MetadataStateObject();

            return state;
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
        private static APIGatewayProxyResponse GenerateHelpText()
        {
            var str = new StringBuilder();
            str.AppendLine("*Graybox Device State Help*");
            str.AppendLine("=========================");
            str.AppendLine("Commands are in the format {box-id} {command} {optionalParameters}. ");
            str.AppendLine("An example command is: `/graybox graybox-001A get-device-state`");
            str.AppendLine();
            str.AppendLine("Available commands are: ");
            str.AppendLine("  • get-device-state (or get)");
            str.AppendLine("  • set-device-state (or set)");
            str.AppendLine("  • add-scheduled-recording (or asr)");
            str.AppendLine("  • remove-scheduled-recording (or rsr)");
            str.AppendLine("  • list-devices _(coming soon)_");
            str.AppendLine();
            str.AppendLine("get-device-state: ");
            str.AppendLine("> has no additional parameters");
            str.AppendLine("set-device-state: ");
            str.AppendLine("> takes in the parameter to change and the new value");
            str.AppendLine("> ex. `/graybox graybox-001A set-device-state encoderEnabled true`");
            str.AppendLine("> Strings should be surrounded in double quotes. Booleans and Ints should be plain.");
            str.AppendLine("add-scheduled-recording: ");
            str.AppendLine("> First parameter is the start date. Second parameter is the end date.");
            str.AppendLine("> ex. `/graybox graybox-001A add-scheduled-recording 2017-03-07T18:00:00Z 2017-03-07T19:00:00Z`");
            str.AppendLine("> All dates are assumed to be UTC. This can be changed by replacing `Z` with a TZ offset like `-5`.");
            str.AppendLine("remove-scheduled-recording: ");
            str.AppendLine("> Takes one parameter which is the scheduled recording number to remove (1 based index)");
            str.AppendLine("> ex. `/graybox graybox-001A remove-scheduled-recording 1`");
            str.AppendLine();
            str.AppendLine();

            return new APIGatewayProxyResponse
            {
                StatusCode = (int)HttpStatusCode.OK,
                Body = str.ToString(),
                Headers = new Dictionary<string, string> { { "Content-Type", "text/plain" } }
            };  
        }
        private static bool IsValidSetStateParameter(string parameter)
        {
            var props = System.Reflection.TypeExtensions.GetProperties(typeof(DesiredStateObject));
            var propNames = props.Select(p=>p.Name).ToList();
            //don't allow this variable to get set directly - can cause issues
            if(parameter.Equals("scheduledRecordings", StringComparison.OrdinalIgnoreCase)) return false;

            return propNames.Contains(parameter);
        }
        private static bool IsValidParameterValue(string value)
        {
            bool tmpBool;
            int tmpInt;
            if(bool.TryParse(value, out tmpBool)) return true;
            if(int.TryParse(value, out tmpInt)) return true;

            if(value.StartsWith("\"") && value.EndsWith("\"")) return true;

            return false;
        }
    }

    internal class GrayboxDeviceState
    {
        public InternalState state {get;set;}
        public MetadataStateObject metadata {get;set;}
    }
    internal class InternalState
    {
        public DesiredStateObject desired {get;set;}
        public ReportedStateObject reported {get;set;}
    }
    internal class MetadataStateObject 
    {
        public MetadataReportedObject reported {get;set;}

    }
    internal class MetadataReportedObject {
        // NOTE: just need one to grab the time
        public MetadataTimeObject loadAverage {get;set;}
    }
    internal class MetadataTimeObject
    {
        public long timestamp {get;set;}
    }
    internal class ReportedStateObject
    {
        public bool ffmpegRunning {get;set;}
        public int filesPendingUpload {get;set;}
        public bool isUploaderRunning {get;set;}
        public string oldestFileName {get;set;}
        public string newestFileName {get;set;}
        public double lastUploadDurationSec {get;set;}
        public double lastUploadSpeedMBps {get;set;}
        public bool iotConnected {get;set;}
        public string deviceId {get;set;}
        public string internalIps {get;set;}
        public string externalIp {get;set;}
        public string freeMemory {get;set;}
        public string loadAverage {get;set;}
        public string diskPercentInUse {get;set;}
        public bool cameraPing {get;set;}
        public string lastSnapshotUrl {get;set;}
        public bool isNgrokRunning {get;set;}
        public string ngrokSshAddress {get;set;}
    }
    internal class DesiredStateObject 
    {
        public bool encoderEnabled {get;set;}
        public string cameraIp {get;set;}
        public string cameraPort {get;set;}
        public string rtmpStreamPath {get;set;}
        public bool localCameraProxy {get;set;}
        public bool audioFromCameraEnabled {get;set;}
        public bool forceRtspTcp {get;set;}
        public bool snapshotEnabled {get;set;}
        public string snapshotPort {get;set;}
        public string snapshotPath {get;set;}
        public bool ngrokEnabled {get;set;}
        public string ngrokAuthtoken {get;set;}
        public string firewallEnabled {get;set;}
        public List<ScheduledRecording> scheduledRecordings {get;set;}

    }
    internal class ScheduledRecording
    {
        public string startDate {get;set;}
        public string endDate {get;set;}
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
