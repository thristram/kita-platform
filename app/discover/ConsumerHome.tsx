"use client";

import { useState } from "react";

const discoveryEvents = [
  { title: "Anime Expo 2027", type: "Convention", date: "Jul 2–5", place: "Los Angeles, CA", reason: "Because you follow Frieren", tone: "coral", distance: "6 mi" },
  { title: "YOASOBI Live in Seattle", type: "Concert", date: "Oct 18", place: "Seattle, WA", reason: "Because you follow YOASOBI", tone: "violet", distance: "Worth the trip" },
  { title: "Frieren Orchestra Concert", type: "Concert", date: "Sep 27", place: "Tokyo, Japan", reason: "Because you follow Frieren", tone: "blue", distance: "Worth the trip" },
  { title: "Good Smile AX Pop-up", type: "Pop-up", date: "Jul 3–6", place: "Los Angeles, CA", reason: "Because you follow Hatsune Miku", tone: "amber", distance: "6 mi" },
];

export function ConsumerHome() {
  const [category, setCategory] = useState("For You");
  const [saved, setSaved] = useState<string[]>(["Anime Expo 2027"]);
  const toggleSaved = (title: string) => setSaved((items) => items.includes(title) ? items.filter((item) => item !== title) : [...items, title]);

  return <main className="consumer-shell">
    <header className="consumer-nav"><a className="consumer-brand" href="/">✦ <b>KitaCon</b></a><nav><button className="active">Discover</button><button>Explore</button><button>Saved <small>{saved.length}</small></button><button>Going</button></nav><button className="consumer-search">⌕ Search fandoms and events <kbd>⌘K</kbd></button><span className="consumer-avatar">KT</span></header>
    <section className="consumer-hero"><div><span className="location-pill">⌖ Los Angeles · within 50 mi</span><h1>Your fandoms are<br/>going places.</h1><p>Discover real-world anime and pop-culture events connected to what you already love.</p><div className="hero-actions"><button>Explore near me</button><button>Adjust interests</button></div></div><div className="hero-collage"><div className="collage-card one"><b>AX</b><span>Anime Expo<br/>2027</span></div><div className="collage-card two"><b>葬</b><span>Frieren<br/>Orchestra</span></div><div className="collage-card three"><b>夜</b><span>YOASOBI<br/>Live</span></div></div></section>
    <section className="consumer-content"><div className="consumer-tabs">{["For You","Near Me","This Weekend","Conventions","Concerts","Pop-ups","Exhibitions"].map((item)=><button key={item} className={category===item?"active":""} onClick={()=>setCategory(item)}>{item}</button>)}</div><div className="consumer-section-head"><div><p className="eyebrow">Personalized discovery</p><h2>{category}</h2><p>Ranked by your fandoms, distance, date, and trusted sources.</p></div><button>View all →</button></div><div className="consumer-event-grid">{discoveryEvents.map((event,index)=><article className="consumer-event-card" key={event.title}><div className={`consumer-art ${event.tone}`}><span>{event.distance}</span><b>{index===0?"AX":["夜","葬","GSC"][index-1]}</b><button onClick={()=>toggleSaved(event.title)} aria-label={`${saved.includes(event.title)?"Remove":"Save"} ${event.title}`}>{saved.includes(event.title)?"♥":"♡"}</button></div><div className="consumer-event-copy"><span>{event.type}</span><h3>{event.title}</h3><p><b>{event.date}</b> · {event.place}</p><small>✦ {event.reason}</small></div></article>)}</div>
    <section className="interest-strip"><div><span>Following 12 fandoms</span><h2>New events from the worlds you care about.</h2></div><div className="interest-bubbles"><span>葬</span><span>初</span><span>鬼</span><span>夜</span><span>＋8</span></div><button>Manage interests →</button></section></section>
    <nav className="mobile-bottom"><button className="active">⌂<span>Home</span></button><button>⌕<span>Explore</span></button><button>♡<span>Saved</span></button><button>✓<span>Going</span></button><button>○<span>Profile</span></button></nav>
  </main>;
}
