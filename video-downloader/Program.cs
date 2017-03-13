using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Linq;
using System.IO;
using System.Globalization;
using Microsoft.Extensions.CommandLineUtils;
using Amazon;
using Amazon.S3;
using Amazon.S3.Model;
using Amazon.S3.Transfer;
using System.Text;

namespace ConsoleApplication
{
    public class Program
    {
        private const int VIDEO_FRAGMENT_LENGTH = 8;
        private const int VIDEO_FRAGMENT_LENGTH_W_BUFFER = VIDEO_FRAGMENT_LENGTH + 2;
        private const string DateTimeFormat = "yyyy-MM-dd HH:mm:ssZ";
        public static int Main(string[] args)
        {
            var app = new CommandLineApplication
            {
                Name = "video-downloader",
                Description = "Graybox video downloader/concater. NOTE: uses AWS Profile credentials stored locally",

            };

            app.OnExecute(() =>
            {
                app.ShowHelp();
                return 2;
            });
            app.Command("list", (c) => {
                var profileOption = c.Option("--profile", "AWS local profile to use (optional)", CommandOptionType.SingleValue);
                var deviceIdOption = c.Option("--deviceId", "Graybox deviceId to download from (required)", CommandOptionType.SingleValue);
                var bucketOption = c.Option("--bucket", "AWS S3 bucket where video is stored (required)", CommandOptionType.SingleValue);

                c.OnExecute(async ()=>
                {
                    if(!ValidateRequiredArguments(deviceIdOption, bucketOption))
                    {
                        return 1;
                    }
                    //get all video fragments in the bucket
                    var bucketLocation = await GetBucketLocation(profileOption.Value(), bucketOption.Value());
                    var videoFrags = await GetVideoFragmentsInBucket(profileOption.Value(), deviceIdOption.Value(), bucketLocation, bucketOption.Value());
                    UpdateDateModifiedWithFilmingDate(videoFrags);
                    var videoRanges = GetVideoRangesFromFragments(videoFrags);

                    DisplayVideoRanges(videoRanges);

                    // Get the download ranges from those fragments
                    // validate that the range is between(inside) available ranges
                    // compile list of video to download
                    // download all the fragments
                    //run concat job to produce final video     
                    return 0;                        
                });
            });
            app.Command("get", (c) => {
                var profileOption = c.Option("--profile", "AWS local profile to use (optional)", CommandOptionType.SingleValue);
                var deviceIdOption = c.Option("--deviceId", "Graybox deviceId to download from (required)", CommandOptionType.SingleValue);
                var bucketOption = c.Option("--bucket", "AWS S3 bucket where video is stored (required)", CommandOptionType.SingleValue);
                var startDateOption = c.Option("--startDate", "Start date in UTC to grab video (required)", CommandOptionType.SingleValue);
                var endDateOption = c.Option("--endDate", "End date in UTC to grab video (required)", CommandOptionType.SingleValue);
                var downloadPathOption = c.Option("--downloadPath", "The full local path to download to (required)", CommandOptionType.SingleValue);
                c.OnExecute(async ()=>
                {
                    if(!ValidateRequiredArguments(deviceIdOption, bucketOption, startDateOption, endDateOption, downloadPathOption))
                    {
                        return 1;
                    }
                    DateTime startDate, endDate;
                    if(!DateTime.TryParseExact(startDateOption.Value(), DateTimeFormat, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out startDate))
                    {
                        Console.WriteLine("Unable to parse start date. Format is: " + DateTimeFormat);
                        return 1;
                    }
                   if(!DateTime.TryParseExact(endDateOption.Value(), DateTimeFormat, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out endDate))
                    {
                        Console.WriteLine("Unable to parse end date. Format is: " + DateTimeFormat);
                        return 1;
                    }
                    startDate = DateTime.SpecifyKind(startDate, DateTimeKind.Utc);
                    endDate = DateTime.SpecifyKind(endDate, DateTimeKind.Utc);

                    var profile = profileOption.Value();
                    var bucket = bucketOption.Value();
                    var downloadPath = downloadPathOption.Value();

                    var bucketLocation = await GetBucketLocation(profile, bucket);
                    //get all video fragments in the bucket
                    var videoFrags = await GetVideoFragmentsInBucket(profile, deviceIdOption.Value(), bucketLocation, bucket);
                    UpdateDateModifiedWithFilmingDate(videoFrags);
                    var videoRanges = GetVideoRangesFromFragments(videoFrags);

                    //DisplayVideoRanges(videoRanges);

                    var rangeToUse = FindVideoRangeForDates(startDate, endDate, videoRanges);
                    if(rangeToUse == null)
                    {
                        Console.WriteLine("Start or End Date does not fall within a recorded video range.");
                        return 1;
                    }
                    Console.WriteLine(string.Format("Using video range {0:u} to {1:u}", rangeToUse.StartDate, rangeToUse.EndDate));
                    var fragmentsToDownload = GetFragmentsToDownload(startDate, endDate, rangeToUse);
                    Console.WriteLine(string.Format("Needing to download {0} fragments", fragmentsToDownload.Count));

                    var localFiles = await DownloadFragments(profile, bucketLocation, bucket, fragmentsToDownload, downloadPath);

                    var fileList = CreateFileList(localFiles, downloadPath);

                    Console.WriteLine("need to run: ffmpeg -f concat -safe 0 -i filelist.txt -c copy output.mp4");
                    //run concat job to produce final video     
                    return 0;                        
                });
            });
            return app.Execute(args);
        }

        private static string CreateFileList(List<string> fragFiles, string downloadPath)
        {
            StringBuilder str = new StringBuilder();
            foreach(var file in fragFiles)
            {
                str.AppendFormat("file '{0}'\n", file);
            }
            var fileListFile = Path.Combine(downloadPath, "filelist.txt");
            File.WriteAllText(fileListFile, str.ToString());

            return fileListFile;
        }
        private static async Task<List<string>> DownloadFragments(string profile, string bucketRegion, string bucket, List<S3Object> fragmentsToDownload, string localDirectory)
        {
            AmazonS3Client regionClient;
            if(string.IsNullOrWhiteSpace(profile))
            {
                regionClient = new AmazonS3Client(new Amazon.Runtime.StoredProfileAWSCredentials(), RegionEndpoint.GetBySystemName(bucketRegion));
            } 
            else
            {
                regionClient = new AmazonS3Client(new Amazon.Runtime.StoredProfileAWSCredentials(profile), RegionEndpoint.GetBySystemName(bucketRegion));
            }

            if(!Directory.Exists(localDirectory))
            {
                Directory.CreateDirectory(localDirectory);
            }
            var returnFileList = new List<string>(fragmentsToDownload.Count);
            TransferUtility tranUtility = new TransferUtility(regionClient);
            foreach(var frag in fragmentsToDownload)
            {
                var localFileName = Path.GetFileName(frag.Key);
                var localFullPath = Path.Combine(localDirectory, localFileName);
                await tranUtility.DownloadAsync(new TransferUtilityDownloadRequest()
                {
                    FilePath = localFullPath,
                    BucketName = frag.BucketName,
                    Key = frag.Key,
                });
                Console.WriteLine(string.Format("Successfully downloaded {0}", localFileName));
                returnFileList.Add(localFullPath);
            }

            return returnFileList;
        }
        private static List<S3Object> GetFragmentsToDownload(DateTime startDate, DateTime endDate, S3FragmentRange range)
        {         
            return range.ContainedFragments.Where(f=>f.LastModified >= startDate && f.LastModified<=endDate).ToList();
        }
        private static S3FragmentRange FindVideoRangeForDates(DateTime startDate, DateTime endDate, List<S3FragmentRange> videoRanges)
        {
            foreach(var r in videoRanges)
            {
                if(startDate >= r.StartDate && endDate <= r.EndDate)
                {
                    return r;
                }
            }

            return null;
        }
        private static void DisplayVideoRanges(List<S3FragmentRange> videoRanges)
        {
            foreach(var r in videoRanges)
            {
                Console.WriteLine(string.Format("StartDate: {0:u}\t\tEndDate: {1:u}\t\tFragCount:{2}", r.StartDate, r.EndDate, r.ContainedFragments.Count));
            }
        }
        private static List<S3FragmentRange> GetVideoRangesFromFragments(List<S3Object> frags)
        {
            List<S3FragmentRange> ranges = new List<S3FragmentRange>();
            S3FragmentRange curRange = null;

            foreach(var frag in frags.OrderBy(f=>f.LastModified))
            {
                if(curRange == null || frag.LastModified > curRange.EndDate.AddSeconds(VIDEO_FRAGMENT_LENGTH_W_BUFFER))
                {
                    curRange = new S3FragmentRange
                    {
                        StartDate = frag.LastModified,
                        ContainedFragments = new List<S3Object>(),
                    };
                    ranges.Add(curRange);
                }

                curRange.EndDate = frag.LastModified;
                curRange.ContainedFragments.Add(frag);

            }

            return ranges;
        }
        private static void  UpdateDateModifiedWithFilmingDate(List<S3Object> objs)
        {
            foreach(var o in objs)
            {
                var fileName = Path.GetFileNameWithoutExtension(o.Key);
                // filename like: outputYYYY-MM-DD_HH-MM-SS
                var date = fileName.Substring(6, 19);

                var dateObj = DateTime.SpecifyKind(DateTime.ParseExact(date, "yyyy-MM-dd_HH-mm-ss", CultureInfo.InvariantCulture), DateTimeKind.Utc);
                o.LastModified = dateObj;
            }
        }
        private static async Task<string> GetBucketLocation(string profile, string bucket)
        {
            AmazonS3Client nonRegionClient;
            if(string.IsNullOrWhiteSpace(profile))
            {
                nonRegionClient = new AmazonS3Client(new Amazon.Runtime.StoredProfileAWSCredentials(), RegionEndpoint.USEast1);
            } 
            else
            {
                nonRegionClient = new AmazonS3Client(new Amazon.Runtime.StoredProfileAWSCredentials(profile), RegionEndpoint.USEast1);
            }
            S3Region bucketLocation;
            using(nonRegionClient)
            {
                var bucketLocationResp = await nonRegionClient.GetBucketLocationAsync(bucket);
                bucketLocation = bucketLocationResp.Location;
            }
            Console.WriteLine("Found bucket region: " + bucketLocation.Value);
            return bucketLocation.Value;
        }
        private static async Task<List<S3Object>> GetVideoFragmentsInBucket(string profile, string deviceId, string bucketLocation, string bucket)
        {
            AmazonS3Client regionClient;
            if(string.IsNullOrWhiteSpace(profile))
            {
                regionClient = new AmazonS3Client(new Amazon.Runtime.StoredProfileAWSCredentials(), RegionEndpoint.GetBySystemName(bucketLocation));
            } 
            else
            {
                regionClient = new AmazonS3Client(new Amazon.Runtime.StoredProfileAWSCredentials(profile), RegionEndpoint.GetBySystemName(bucketLocation));
            }

            var reverseDeviceId = new string(deviceId.ToCharArray().Reverse().ToArray());

            List<S3Object> deviceFiles = new List<S3Object>();
            string continuationToken = null;
            while(true)
            {
                var request = new ListObjectsV2Request()
                {
                    BucketName = bucket,
                    MaxKeys = 1000,
                    Prefix = reverseDeviceId + "/",
                    ContinuationToken = continuationToken,
                };
                var resp = await regionClient.ListObjectsV2Async(request);

                //don't add files that are clearly too small or not video
                deviceFiles.AddRange(resp.S3Objects.Where(s=> IsValidVideo(s)));
                //Console.WriteLine(string.Format("Current size {0}", deviceFiles.Count));

                if(!resp.IsTruncated)
                {
                    break;
                }
                continuationToken = resp.ContinuationToken;
            }
            Console.WriteLine(string.Format("Found {0} matching video fragments.", deviceFiles.Count));

            return deviceFiles;
        }

        private static readonly List<string> ValidExtensions = new List<string> {".mp4", ".ts", ".mkv"};
        private static bool IsValidVideo(S3Object obj)
        {
            if(obj.Size < 10000) return false;
            var ext = Path.GetExtension(obj.Key)?.ToLowerInvariant();
            if(!ValidExtensions.Contains(ext)) return false;

            return true;
        }
        private static bool ValidateRequiredArguments(params CommandOption[] optionsToValidate)
        {
            foreach(var param in optionsToValidate)
            {
                if(!param.HasValue())
                {
                    Console.WriteLine(string.Format("Required parameter '{0}' was not passed in.", param.LongName));
                    return false;
                }
            }
            return true;
        }
    }

    internal class S3FragmentRange
    {
        public DateTime StartDate {get;set;}
        public DateTime EndDate {get;set;}
        public List<S3Object> ContainedFragments {get;set;}
    }
}
