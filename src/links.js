const enc = encodeURIComponent;

// Transit directions from `from` ({lat,lng}) to a place ({name,address,lat,lng}).
export function googleMapsLink(from, to, travelmode = 'transit') {
  const dest = to.address ? `${to.name}, ${to.address}` : `${to.lat},${to.lng}`;
  const origin = from ? `&origin=${from.lat},${from.lng}` : '';
  return `https://www.google.com/maps/dir/?api=1${origin}&destination=${enc(dest)}&travelmode=${travelmode}`;
}

export function citymapperLink(from, to) {
  const start = from ? `startcoord=${from.lat},${from.lng}&` : '';
  const addr = to.address ? `&endaddress=${enc(to.address)}` : '';
  return `https://citymapper.com/directions?${start}endcoord=${to.lat},${to.lng}&endname=${enc(to.name)}${addr}`;
}

// `region` scopes the search so "the chip shop" lands in the right city. It used to be
// the literal string 'London', which meant a trip to anywhere else searched the wrong
// place — pass trip.region.name.
export function googleSearchLink(query, region = '') {
  const scoped = region ? `${query}, ${region}` : query;
  return `https://www.google.com/maps/search/?api=1&query=${enc(scoped)}`;
}
