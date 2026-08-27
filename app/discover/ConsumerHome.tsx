"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's dev Link shim currently duplicates React. */

import { useState } from "react";
import { Bookmark, Compass, Heart, Home, MapPin, Search, Sparkles, UserRound } from "lucide-react";

interface DiscoveryEvent {
  eventId: string;
  slug: string;
  eventType: string;
  title: string;
  startAt: string | null;
  city: string | null;
  region: string | null;
  primaryImageUrl: string | null;
  dataOrigin: "LIVE" | "MOCK";
}

export function ConsumerHome({ events }: { events: DiscoveryEvent[] }) {
  const [category, setCategory] = useState("For You");
  const [saved, setSaved] = useState<string[]>(["Anime Expo 2027"]);
  const toggleSaved = (title: string) => setSaved((items) => items.includes(title) ? items.filter((item) => item !== title) : [...items, title]);

  return <main className="consumer-shell">
    <header className="consumer-nav"><a className="consumer-brand" href="/"><Sparkles size={17}/> <b>KitaCon</b></a><nav><button className="active">Discover</button><button>Explore</button><button>Saved <small>{saved.length}</small></button><button>Going</button></nav><button className="consumer-search"><Search size={14}/> Search fandoms and events <kbd>⌘K</kbd></button><span className="consumer-avatar">KT</span></header>
    <section className="consumer-hero"><div><span className="location-pill"><MapPin size={12}/> Los Angeles · within 50 mi</span><h1>Your fandoms are<br/>going places.</h1><p>Discover real-world anime and pop-culture events connected to what you already love.</p><div className="hero-actions"><button>Explore near me</button><button>Adjust interests</button></div></div><div className="hero-collage"><div className="collage-card one"><b>AX</b><span>Anime Expo<br/>2027</span></div><div className="collage-card two"><b>葬</b><span>Frieren<br/>Orchestra</span></div><div className="collage-card three"><b>夜</b><span>YOASOBI<br/>Live</span></div></div></section>
    <section className="consumer-content"><div className="consumer-tabs">{["For You","Near Me","This Weekend","Conventions","Concerts","Pop-ups","Exhibitions"].map((item)=><button key={item} className={category===item?"active":""} onClick={()=>setCategory(item)}>{item}</button>)}</div><div className="consumer-section-head"><div><p className="eyebrow">Database discovery</p><h2>{category}</h2><p>Published serving projections ordered by date and popularity.</p></div><button>View all →</button></div><div className="consumer-event-grid">{events.map((event,index)=>{const date=event.startAt?new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(event.startAt)):"Date pending";const tone=["coral","violet","blue","amber"][index%4];return <article className="consumer-event-card" key={event.eventId}><div className={`consumer-art ${tone}`}><span>{event.dataOrigin === "MOCK" ? "Preview data" : "Published"}</span><b>{index===0?"AX":["夜","葬","GSC"][index%3]}</b><button onClick={()=>toggleSaved(event.title)} aria-label={`${saved.includes(event.title)?"Remove":"Save"} ${event.title}`}>{saved.includes(event.title)?<Heart size={15} fill="currentColor"/>:<Heart size={15}/>}</button></div><div className="consumer-event-copy"><span>{event.eventType.replaceAll("_"," ")}</span><h3>{event.title}</h3><p><b>{date}</b> · {[event.city,event.region].filter(Boolean).join(", ") || "Venue pending"}</p><small><Sparkles size={11}/> Published from the canonical database</small></div></article>})}</div>
    <section className="interest-strip"><div><span>Following 12 fandoms</span><h2>New events from the worlds you care about.</h2></div><div className="interest-bubbles"><span>葬</span><span>初</span><span>鬼</span><span>夜</span><span>＋8</span></div><button>Manage interests →</button></section></section>
    <nav className="mobile-bottom"><button className="active"><Home size={16}/><span>Home</span></button><button><Compass size={16}/><span>Explore</span></button><button><Bookmark size={16}/><span>Saved</span></button><button><Heart size={16}/><span>Going</span></button><button><UserRound size={16}/><span>Profile</span></button></nav>
  </main>;
}
