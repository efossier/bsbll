/*Game Parser
    
    Should be called by the server script periodically.
    Downloads the current game information live from mlb.com in JSON and cherrypicks necessary information and puts it in the GAMES array
    For Upcoming and Final games, downloads pitcher images from espn.com and adds them to the assets folder.
*/

var request = require('request');
var fs = require('fs');
var cheerio = require('cheerio');
var util = require('./utils.js');
var sprintf = require('sprintf-js').sprintf;
var log = require('bunyan').createLogger({
    name: 'game-parser',
    level: 'TRACE'
});

/* Constants */
var SCOREBOARD_URI_TEMPLATE = "http://gd2.mlb.com/components/game/mlb/year_%s/month_%s/day_%s/master_scoreboard.json";

var PITCHER_PATH_PREFIX = "assets/img/players/";
var GENERIC_PATH = PITCHER_PATH_PREFIX + "generic.png";
var TEAM_LOGO_PATH_PREFIX = "assets/img/teams/";

var MAX_PNAME_LENGTH = 10;
var HTTP_TIMEOUT = 15 * 1000; //ms

var num_asynch_reqs = 0;
var result;

var team_abbreviation = {
    "Baltimore" : "bal",
    "Boston" : "bos",
    "NY Yankees" : "nyy",
    "Tampa Bay" : "tam",
    "Toronto" : "tor",
    "Chi White Sox": "chw",
    "Cleveland" : "cle",
    "Detroit" : "det",
    "Kansas City" : "kan",
    "Minnesota": "min",
    "Houston" : "hou",
    "LA Angels": "laa",
    "Oakland" : "oak",
    "Seattle" : "sea",
    "Texas" : "tex",
    "Atlanta" : "atl",
    "Miami": "mia",
    "NY Mets": "nym",
    "Philadelphia" : "phi",
    "Washington": "was",
    "Chi Cubs": "chc",
    "Cincinnati": "cin",
    "Milwaukee": "mil",
    "Pittsburgh": 'pit',
    "St. Louis": "stl",
    "Arizona": "ari",
    "Colorado": "col",
    "LA Dodgers": "lad",
    "San Diego": "sdg",
    "San Francisco": "sfo",
    "AL All-Stars": "al",
    "NL All-Stars": "nl"
};

var time_zones = {
    "Baltimore" : "EST",
    "Boston" : "EST",
    "NY Yankees" : "EST",
    "Tampa Bay" : "EST",
    "Toronto" : "EST",
    "Chi White Sox": "CST",
    "Cleveland" : "EST",
    "Detroit" : "EST",
    "Kansas City" : "CST",
    "Minnesota": "CST",
    "Houston" : "MST",
    "LA Angels": "PST",
    "Oakland" : "PST",
    "Seattle" : "PST",
    "Texas" : "MST",
    "Atlanta" : "EST",
    "Miami": "EST",
    "NY Mets": "EST",
    "Philadelphia" : "EST",
    "Washington": "EST",
    "Chi Cubs": "CST",
    "Cincinnati": "EST",
    "Milwaukee": "CST",
    "Pittsburgh": 'EST',
    "St. Louis": "CST",
    "Arizona": "MST",
    "Colorado": "MST",
    "LA Dodgers": "PST",
    "San Diego": "PST",
    "San Francisco": "PST"
};

var weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/*
    PRIVATE METHODS CALLED INTERNALLY IN THIS SCRIPT
 */

/**
 * Entry point for getting scoreboard data
 */
function load_scores(callback, specific_date){
    // reset result
    result = {
        games: {
            final_games: [],
            live_games: [],
            upcoming_games: [],
            postponed_games: []
        },
        num_games: 0,
        date_str: undefined,
        date: undefined,
        games_active: 0
    };
    
    var date;
    if (specific_date)
        date = specific_date;
    else
        date = util.get_todays_date();

    /*
        To test a specific date we override values of dd,mm,yyyy
     */
    // dd = 12;

    log.info("Loading scoreboard for "+date["month"]+"/"+date["day"]+"/"+date["year"]+" "+date["hour"]+":"+date["minute"]);

    var day_suffix;
    if(date["day"] % 10 == 1) day_suffix = "st";
    else if(date["day"] % 10 == 2) day_suffix = "nd";
    else if(date["day"] % 10 == 3) day_suffix = "rd";
    else day_suffix = "th";

    // Store the current date
    result.date_str = weekdays[date["dow"]] + ", " + months[date["month"]-1] + " " + date["day"] + day_suffix + " " + date["year"];
    result.date = "" + date["month"] + "," + date["day"] + "," + date["year"];

    // Build path
    if(date["day"] < 10) date["day"] = '0' + date["day"];
    if(date["month"] < 10) date["month"] = '0' + date["month"];

    var scoreboard_uri = sprintf(SCOREBOARD_URI_TEMPLATE, date["year"], date["month"], date["day"]);
    log.debug("Scoreboard uri='"+scoreboard_uri+"'");

    request.get(scoreboard_uri, {timeout: HTTP_TIMEOUT}, function(err, res, body){
        if (!err && res.statusCode === 200) 
            parse_scores(body, callback);
        else{
            if (res) log.error("MLB responded with "+res.statusCode + " while downloading scoreboard data for %s", JSON.stringify(date));
            else log.error("No response from MLB.com while doesnloading scoreboard data for %s", JSON.stringify(date))
                
            callback(result);
        }
    });
}

/**
 * Parses the scoreboard json received from mlb into our scoreboard datastructure
 */
function parse_scores(response_text, callback){
    var obj = JSON.parse(response_text);
    var game_data = obj["data"]["games"]["game"];

    // Ensure that game_data is an array, the proceeding code assumes it is and if it is not an array than using the for each loop breaks
    if(game_data !== undefined && !Array.isArray(game_data)){
        log.warn({game_data: game_data}, "Game data is not an array.");
        game_data = [].concat(game_data);
    }
    
    for(var i in game_data){
        result.num_games++;

        // Cherry pick information we need
        var g = game_data[i];
        var data = {};
        data["away_team"] = g["away_team_city"];
        data["home_team"] = g["home_team_city"];
        data["away_team_logo"] = TEAM_LOGO_PATH_PREFIX + team_abbreviation[data["away_team"]] + ".png";
        data["home_team_logo"] = TEAM_LOGO_PATH_PREFIX + team_abbreviation[data["home_team"]] + ".png";
        data["away_rec"] = g["away_win"] + " - " +g["away_loss"];
        data["home_rec"] = g["home_win"] + " - " +g["home_loss"];
        data["status"] = g["status"]["status"];

        // Get Data for in progress game
        if(data["status"] === "In Progress" || data["status"] === "Delayed Start"){
            result.games_active++;
            process_live_game(data, g);
        }
        // Get Data for Final Game
        else if(data["status"] === "Game Over" || data["status"] === "Final" || data["status"] === "Completed Early")
            process_final_game(data, g);
        // Get Data for postponed game
        else if(data["status"] === "Postponed" || data["status"] === "Suspended" || data["status"] === "Cancelled")
            process_postponed_game(data, g);
        // Get Data for upcoming game
        else{
            result.games_active++;
            process_upcoming_game(data, g);
        }

        // Fix long pitcher name abbreviations if necessary
        if(data["away_pitcher_abrv"] && data["away_pitcher_abrv"].length > MAX_PNAME_LENGTH){
            data["away_pitcher_abrv"] = fix_abbrev(data["away_pitcher_abrv"]);
        }
        if(data["home_pitcher_abrv"] && data["home_pitcher_abrv"].length > MAX_PNAME_LENGTH){
            data["home_pitcher_abrv"] = fix_abbrev(data["home_pitcher_abrv"]);
        }
        // Fix long batter names in live games
        if(data["batter_abrv"] && data["batter_abrv"].length > MAX_PNAME_LENGTH){
            data["batter_abrv"] = fix_abbrev(data["batter_abrv"]);
        }
        // Fix long pitcher names in live games
        if(data["pitcher_abrv"] && data["pitcher_abrv"].length > MAX_PNAME_LENGTH){
            data["pitcher_abrv"] = fix_abbrev(data["pitcher_abrv"]);
        }

        if(data["status"] === "UPCOMING") result.games.upcoming_games.push(data);
        else if(data["status"] === "LIVE") result.games.live_games.push(data);
        else if(data["status"] === "POSTPONED") result.games.postponed_games.push(data);
        else result.games.final_games.push(data);
    }

    wait_for_asynch_reqs(callback);
}

function process_live_game(data, g){
    if(data["status"] === "Delayed Start") data["display_status"] = "DELAYED";
    else data["display_status"] = "LIVE";

    data["status"] = "LIVE";
    
    data["away_score"] = g["linescore"]["r"]["away"];
    data["home_score"] = g["linescore"]["r"]["home"];

    data["inning_num"] = g["status"]["inning"];
    data["inning_arrow"] = g["status"]["inning_state"] === "Bottom" ? "down" : "up";

    // Runners
    data["runners"] = {};
    if(g["runners_on_base"]["runner_on_1b"]) data["runners"]["1b"] = 1;
    if(g["runners_on_base"]["runner_on_2b"]) data["runners"]["2b"] = 1;
    if(g["runners_on_base"]["runner_on_3b"]) data["runners"]["3b"] = 1;

    // Pitcher
    data["pitcher"] = g["pitcher"]["first"] + " " + g["pitcher"]["last"];
    data["pitcher_abrv"] = g["pitcher"]["first"].slice(0,1) + ". " + g["pitcher"]["last"];
    data["pitcher_era"] = g["pitcher"]["era"];

    // Batter
    data["batter"] = g["batter"]["first"] + " " + g["batter"]["last"];
    data["batter_abrv"] = g["batter"]["first"].slice(0,1) + ". " + g["batter"]["last"];
    data["batter_avg"] = g["batter"]["avg"];

    // Balls
    data["count"] = {};
    data["count"]["b"] = {}; 
    var num_balls = parseInt(g["status"]["b"]);
    var i;
    for(i = 0; i < num_balls; i++)
        data["count"]["b"]["p"+i] = 1;
    
    // Strikes
    data["count"]["s"] = {};
    var num_strikes = parseInt(g["status"]["s"]);
    for(i = 0; i < num_strikes; i++)
        data["count"]["s"]["p"+i] = 1;

    // Outs
    data["count"]["o"] = {};
    var num_outs = parseInt(g["status"]["o"]);
    for(i = 0; i < num_outs; i++)
        data["count"]["o"]["p"+i] = 1;
}

function process_final_game(data, g){
    data["status"] = "FINAL";
    data["display_status"] = data["status"];
    data["away_score"] = g["linescore"]["r"]["away"];
    data["home_score"] = g["linescore"]["r"]["home"];
    // Check if game went to extra innings
    if(parseInt(g["status"]["inning"]) > 9){
        data["display_status"] += " - " + g["status"]["inning"];
    }
    // Find winning and losing pitchers
    if(parseInt(data["away_score"]) < parseInt(data["home_score"])){
        data["winner"] = "home";
        data["away_result"] = "L";
        data["home_result"] = "W";
        data["away_pitcher"] = g["losing_pitcher"]["first"] + " " + g["losing_pitcher"]["last"];
        data["away_pitcher_abrv"] = g["losing_pitcher"]["first"].slice(0,1) +". " + g["losing_pitcher"]["last"];
        data["away_pitcher_rec"] = g["losing_pitcher"]["wins"] + "-" + g["losing_pitcher"]["losses"];
        data["away_pitcher_era"] = g["losing_pitcher"]["era"];
        data["home_pitcher"] = g["winning_pitcher"]["first"] + " " +g["winning_pitcher"]["last"];
        data["home_pitcher_rec"] = g["winning_pitcher"]["wins"] + "-" + g["winning_pitcher"]["losses"];
        data["home_pitcher_era"] = g["winning_pitcher"]["era"];
        data["home_pitcher_abrv"] = g["winning_pitcher"]["first"].slice(0,1) +". " + g["winning_pitcher"]["last"];

    }
    else{
        data["winner"] = "away";
        data["away_result"] = "W";
        data["home_result"] = "L";
        data["away_pitcher"] = g["winning_pitcher"]["first"] + " " +g["winning_pitcher"]["last"];
        data["away_pitcher_abrv"] = g["winning_pitcher"]["first"].slice(0,1) +". " + g["winning_pitcher"]["last"];
        data["away_pitcher_rec"] = g["winning_pitcher"]["wins"] + "-" + g["winning_pitcher"]["losses"];
        data["away_pitcher_era"] = g["winning_pitcher"]["era"];
        data["home_pitcher"] = g["losing_pitcher"]["first"] + " "+ g["losing_pitcher"]["last"];
        data["home_pitcher_abrv"] = g["losing_pitcher"]["first"].slice(0,1) +". " + g["losing_pitcher"]["last"];
        data["home_pitcher_rec"] = g["losing_pitcher"]["wins"] + "-" + g["losing_pitcher"]["losses"];
        data["home_pitcher_era"] = g["losing_pitcher"]["era"];
    }
    // Load pitcher images if they havent already been downloaded
    get_pitcher_image(data, true);
    get_pitcher_image(data, false);
}

function process_postponed_game(data, g){
    data["display_status"] = data["status"].toUpperCase() ;
    data["status"] = "POSTPONED";
    data["reason"] = g["status"]["reason"];
    data["reason_img"] = "/assets/img/weather/" + data["reason"].toLowerCase() + ".png";

    data["game_time"] = g["home_time"] + g["ampm"].toLowerCase();
    data["game_tzone"] = time_zones[data["home_team"]];
    data["stadium"] = g["venue"];
    log.warn("Got postponed game with resume_date set: "+g["resume_date"]);

    if (!g["resume_date"] || g["resume_date"].length === 0) data["eta"] = "unknown";
    else data["eta"] = g["resume_date"];
}

function process_upcoming_game(data, g){
    var away_pitcher, home_pitcher;
    if(data["status"] === "Preview"){
        away_pitcher = "away_probable_pitcher";
        home_pitcher = "home_probable_pitcher";
    }
    else{
        home_pitcher = "pitcher";
        away_pitcher = "opposing_pitcher";
    }
    data["display_status"] = (data["status"] === "Delayed Start") ? "DELAYED" : "PREVIEW";
    data["status"] = "UPCOMING";
    data["away_pitcher"] = g[away_pitcher]["first"] + " " +g[away_pitcher]["last"];
    data["away_pitcher_abrv"] = g[away_pitcher]["first"].slice(0,1) + ". " +g[away_pitcher]["last"]
    data["away_pitcher_rec"] = g[away_pitcher]["wins"] + "-" + g[away_pitcher]["losses"];
    data["away_pitcher_era"] = g[away_pitcher]["era"];
    // Download away pitcher image
    get_pitcher_image(data, true);
    data["home_pitcher"] = g[home_pitcher]["first"] + " "+ g[home_pitcher]["last"];
    data["home_pitcher_abrv"] = g[home_pitcher]["first"].slice(0,1) + ". " +g[home_pitcher]["last"]
    data["home_pitcher_rec"] = g[home_pitcher]["wins"] + "-" + g[home_pitcher]["losses"];
    data["home_pitcher_era"] = g[home_pitcher]["era"];
    // Download home pitcher image
    get_pitcher_image(data, false);

    data["game_time"] = g["home_time"] + g["ampm"].toLowerCase();
    data["game_tzone"] = time_zones[data["home_team"]];
    data["stadium"] = g["venue"];
}


/**
 * Abrreviate pitcher's last name to fit on game card
 */
function fix_abbrev(name){
    // First try and use just the last name
    var lastnameonly = name.slice(3);
    if(lastnameonly.length <= MAX_PNAME_LENGTH) return lastnameonly;
    else return lastnameonly.slice(0,MAX_PNAME_LENGTH-1) + ".."; //Otherwise just truncate name & add ..
}

// Waits until all the asynchronous requests have completed then calls callback which returns the data to the server
function wait_for_asynch_reqs(callback){
    if(num_asynch_reqs > 0){
        log.info("Waiting on asynch reqs ("+num_asynch_reqs+" left)");
        setTimeout(function(){
            wait_for_asynch_reqs(callback);
        }, 2000);
    }
    else{
        log.info("Done loading scoreboard");
        print_scores();
        // Return the games array and call the callback
        callback(result);
    }
}

function print_scores(){
    log.debug("Printing collected data...");
    log.debug("LIVE GAMES");
    log.debug(JSON.stringify(result.games.live_games));
    log.debug("FINAL GAMES");
    log.debug(JSON.stringify(result.games.final_games));
    log.debug("UPCOMING GAMES");
    log.debug(JSON.stringify(result.games.upcoming_games));
    log.debug("POSTPONED GAMES");
    log.debug(JSON.stringify(result.games.postponed_games));
}

// Checks if we already have pitcher's image, if not downloads the image from espn
function get_pitcher_image(data, away_bool){
    var pitcher_name; 
    if(away_bool) pitcher_name = data["away_pitcher"];
    else pitcher_name = data["home_pitcher"];

    var team;
    if(away_bool) team =  data["away_team"];
    else team = data["home_team"];

    log.info("Looking for pitcher "+pitcher_name);
    var path = PITCHER_PATH_PREFIX + pitcher_name.split(" ").join("").toLowerCase()+".png";
    num_asynch_reqs++; //Indicate we are starting a sequence of asynchronous requests
    log.info(">>>Num asynch reqs ++, = "+num_asynch_reqs);
    fs.open(path,'r',function(err,fd){
        if (err && err.code=='ENOENT') download_image(data, away_bool, path);
        else{
            log.info("Already have pitcher image for %s : %s ", pitcher_name, path);
            if(!away_bool) data["home_pitcher_img_path"] = path;
            else data["away_pitcher_img_path"] = path;

            decr_asynch_reqs();
        } 
    });
}

function download_image(data, away_bool, fname){
    var pitcher_name; 
    if(away_bool) pitcher_name = data["away_pitcher"];
    else pitcher_name = data["home_pitcher"];

    var team;
    if(away_bool) team =  data["away_team"];
    else team = data["home_team"];

    var uri = "http://espn.go.com/mlb/teams/roster?team="+ team_abbreviation[team];
    log.info("("+pitcher_name+")team uri="+uri);

    // Go to roster page to find player
    request.get(uri, {'timeout': HTTP_TIMEOUT}, function(err,res,body){
        if(!err && res.statusCode == 200){
            var $ = cheerio.load(body);
            var found_player = false;
            // Find the player
            $(".evenrow, .oddrow").each(function(i,elem){
                var $pitcher = $(this).find("a");
                if($pitcher.text().toLowerCase() === pitcher_name.toLowerCase()){
                    found_player = true;

                    // Go to player page
                    uri = $pitcher.attr("href");
                    log.info("("+pitcher_name+") player uri="+uri);

                    request.get(uri, {'timeout': HTTP_TIMEOUT}, function(err, res, body){
                        if(!err && res.statusCode === 200){
                            $ = cheerio.load(body);
                            var $pic = $(".main-headshot").children().first();
                            log.info("pic url="+$pic.attr("src"));
                            if(!$pic.attr("src")){
                                set_generic_pitcher_image("ERROR: player "+pitcher_name+" has no picture, skipping", away_bool, data);
                                return;
                            }
                            // Get src attribute of pitcher's img tag
                            uri = $pic.attr("src");
                            var filename = fname;
                            // Download the image
                            request
                                .get(uri, {"timeout": HTTP_TIMEOUT})
                                .pipe(fs.createWriteStream(filename))
                                .on('close', function(){
                                    log.info("Downloaded image for "+pitcher_name + " to "+filename);
                                    // Populate the appropriate fields in data
                                    if(!away_bool) data["home_pitcher_img_path"] = filename;
                                    else data["away_pitcher_img_path"] = filename;

                                    decr_asynch_reqs();
                                })
                                .on('error', function(err){
                                    set_generic_pitcher_image("Downloaded image for "+pitcher_name + " to "+filename, away_bool, data);
                                });
                        }
                        else{
                            var err_type = err.connect === true ? "Connection Error" : "Timed Out";
                            set_generic_pitcher_image("("+pitcher_name+") Error getting to pitcher page ["+err_type+"]", away_bool, data);
                        }
                    });

                    // Stop the loop
                    return false;
                }
            });

            if(!found_player){
                set_generic_pitcher_image("("+pitcher_name+") Unable to find player in roster", away_bool, data);
            }

        }
        else{
            set_generic_pitcher_image("("+pitcher_name+") Error getting to roster page for player", away_bool, data);
        }
    });
}

function set_generic_pitcher_image(err_msg, away_bool, data) {
    log.info(err_msg);
    // Just use generic pitcher image
    if(!away_bool) data["home_pitcher_img_path"] = GENERIC_PATH;
    else data["away_pitcher_img_path"] = GENERIC_PATH;

    decr_asynch_reqs();
}

function decr_asynch_reqs() {
    num_asynch_reqs--;
    log.info(">>>Num asynch reqs --, = "+num_asynch_reqs);
}

/*
    PUBLIC METHOD CALLED BY MAIN SERVER SCRIPT
 */

exports.load_scoreboard = function(callback, date){
    load_scores(callback, date);
}
