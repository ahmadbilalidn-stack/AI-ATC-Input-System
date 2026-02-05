// ==UserScript==
// @name         GeoFS AI (GPT) ATC – Text Popup + Auto METAR
// @namespace    https://avramovic.info/
// @version      3.0
// @description  AI ATC for GeoFS with text input + real weather METAR
// @author       Nemanja Avramovic + Mod
// @license      MIT
// @match        https://www.geo-fs.com/geofs.php*
// @grant        GM.getResourceText
// @grant        GM.getResourceUrl
// @grant        unsafeWindow
// @resource     airports https://github.com/avramovic/geofs-ai-atc/raw/master/airports.json
// @resource     radiostatic https://github.com/avramovic/geofs-ai-atc/raw/master/radio-static.mp3
// @grant        GM_xmlhttpRequest
// @connect      tgftp.nws.noaa.gov
// ==/UserScript==

(function() {
'use strict';

/* LOAD LIBRARIES */
const head = document.querySelector('head');
if (head) {
    const puterJS = document.createElement('script');
    puterJS.src = 'https://js.puter.com/v2/';
    head.appendChild(puterJS);

    const growlJS = document.createElement('script');
    growlJS.src = 'https://cdn.jsdelivr.net/gh/avramovic/geofs-ai-atc@master/vanilla-notify.min.js';
    head.appendChild(growlJS);

    const growlCSS = document.createElement('link');
    growlCSS.href = 'https://cdn.jsdelivr.net/gh/avramovic/geofs-ai-atc@master/vanilla-notify.css';
    growlCSS.rel = 'stylesheet';
    head.appendChild(growlCSS);
}

/* LOAD DATA */
let airports;
GM.getResourceText("airports").then(data => airports = JSON.parse(data));

let radiostatic;
GM.getResourceUrl("radiostatic").then(data => radiostatic = new Audio('data:audio/mp3;' + data));

let tunedInAtc;
let controllers = {};
let context = {};
let metarData = {};
let metarInterval = null;

/* ================= METAR FETCH ================= */

function fetchMetar(icao) {
    GM_xmlhttpRequest({
        method: "GET",
        url: `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`,
        onload: function(response) {
            try {
                const text = response.responseText.trim();
                const lines = text.split("\n");
                const metar = lines[1] || "METAR unavailable";
                metarData[icao] = metar;
                console.log("✅ METAR updated:", icao, metar);
            } catch (e) {
                console.log("METAR parse error", e);
                metarData[icao] = "Weather unavailable";
            }
        },
        onerror: function() {
            console.log("❌ METAR fetch failed");
            metarData[icao] = "Weather unavailable";
        }
    });
}


/* UI BUTTONS */
const observer = new MutationObserver(() => {
    const menuList = document.querySelector('div.geofs-ui-bottom');
    if (menuList && !menuList.querySelector('.geofs-atc-icon')) {

        const micIcon = document.createElement('i');
        micIcon.className = 'material-icons';
        micIcon.innerText = 'headset_mic';

        const knobIcon = document.createElement('i');
        knobIcon.className = 'material-icons';
        knobIcon.innerText = 'radio';

        const tuneInButton = document.createElement('button');
        tuneInButton.className = 'mdl-button mdl-js-button mdl-button--icon geofs-f-standard-ui';
        tuneInButton.title = "Set ATC frequency";

        tuneInButton.onclick = () => {
            let nearestAp = findNearestAirport();
            let apCode = prompt('Enter airport ICAO code', nearestAp.code);
            if (!apCode) return;
            apCode = apCode.toUpperCase();
            if (!unsafeWindow.geofs.mainAirportList[apCode]) return alert("Airport not found!");

            tunedInAtc = apCode;
            initController(apCode);

            fetchMetar(apCode);
            if (metarInterval) clearInterval(metarInterval);
            metarInterval = setInterval(() => fetchMetar(apCode), 300000);

            alert("Radio tuned to " + apCode);
        };

        const atcButton = document.createElement('button');
        atcButton.className = 'mdl-button mdl-js-button mdl-button--icon geofs-f-standard-ui geofs-atc-icon';
        atcButton.title = "Talk to ATC";

        atcButton.onclick = () => {
            if (!tunedInAtc) return alert("Set frequency first!");
            let msg = prompt("Enter message to ATC:");
            if (msg) callAtc(msg);
        };

        atcButton.appendChild(micIcon);
        tuneInButton.appendChild(knobIcon);
        menuList.appendChild(tuneInButton);
        menuList.appendChild(atcButton);
    }
});
observer.observe(document.body, {childList: true, subtree: true});

/* ATC VOICE */
function atcSpeak(text) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
function atcMessage(text, airport) {
    vNotify.warning({text:text, title:airport+' ATC', visibleDuration:20000});
    atcSpeak(text);
}

/* DISTANCE */
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = d=>d*Math.PI/180;
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))) / 1.852;
}
function findNearestAirport() {
    let nearest=null,minD=Infinity;
    for (let code in unsafeWindow.geofs.mainAirportList) {
        let d=findAirportDistance(code);
        if(d<minD){minD=d;nearest={code,distance:d};}
    }
    return nearest;
}
function findAirportDistance(code) {
    let pos=unsafeWindow.geofs.aircraft.instance.lastLlaLocation;
    let ap=unsafeWindow.geofs.mainAirportList[code];
    return haversine(pos[0],pos[1],ap[0],ap[1]);
}

/* CONTROLLER */
function initController(code){
    if(controllers[code]) return;
    fetch('https://randomuser.me/api/?seed='+code)
    .then(r=>r.json()).then(j=>controllers[code]=j.results[0]);
}

/* ATC CHAT */
function callAtc(msg){
    let airport={code:tunedInAtc,distance:findAirportDistance(tunedInAtc)};
    if(airport.distance>50) return alert("Out of ATC range");

    if(!context[airport.code]){
        context[airport.code]=[{
            role:'system',
            content:`You are a real air traffic controller at ${airport.code}.
Use real aviation phraseology. Keep replies short and realistic.
Current weather (METAR): ${metarData[airport.code] || "Not available"}`
        }];
    }

    context[airport.code][0].content = `You are a real air traffic controller at ${airport.code}.
Use real aviation phraseology. Keep replies short and realistic.
Current weather (METAR): ${metarData[airport.code] || "Not available"}`;

    context[airport.code].push({role:'user',content:msg});

    puter.ai.chat(context[airport.code]).then(resp=>{
        context[airport.code].push(resp.message);
        atcMessage(resp.message.content, airport.code);
    });
}

})();
