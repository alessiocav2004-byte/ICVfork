import requests
from bs4 import BeautifulSoup
import urllib.parse
import sys
def scrape_dhtindex(query):
    # Format the query for the URL
    encoded_query = urllib.parse.quote_plus(query)
    url = f"https://dhtindex.org/search?q={encoded_query}"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }
    
    print(f"Searching for: '{query}' on dhtindex.org...")
    try:
        response = requests.get(url, headers=headers, timeout=15)
        if response.status_code != 200:
            print(f"Error: Status code {response.status_code}")
            return []
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Find all torrent divs
        # We can look for divs that have the specific hover classes or check within the parent container
        container = soup.find('div', class_='space-y-0')
        if not container:
            # Fallback: find all result divs by looking for classes and structure
            result_divs = soup.find_all('div', class_=lambda x: x and 'hover:bg-card' in x)
        else:
            result_divs = container.find_all('div', recursive=False)
            
        results = []
        for div in result_divs:
            # 1. Title & Details Link
            title_a = div.find('a', class_=lambda x: x and 'text-base' in x)
            if not title_a:
                continue
            title = title_a.get_text(strip=True)
            details_url = "https://dhtindex.org" + title_a['href']
            
            # 2. Metadata (Size, Date, Files, Seeds, Leeches)
            meta_div = div.find('div', class_=lambda x: x and 'text-xs' in x and 'font-mono' in x)
            size = "Unknown"
            date = "Unknown"
            files = "Unknown"
            seeds = "0"
            leeches = "0"
            
            if meta_div:
                spans = meta_div.find_all('span')
                if len(spans) >= 1:
                    size = spans[0].get_text(strip=True)
                if len(spans) >= 2:
                    date = spans[1].get_text(strip=True)
                if len(spans) >= 3:
                    files = spans[2].get_text(strip=True)
                
                # Check for seeds/leeches explicitly by id or class
                for span in spans:
                    span_id = span.get('id', '')
                    if span_id.startswith('s-'):
                        seeds = span.get_text(strip=True).replace('S:', '').strip()
                    elif span_id.startswith('l-'):
                        leeches = span.get_text(strip=True).replace('L:', '').strip()
            
            # 3. Magnet Link
            magnet_a = div.find('a', href=lambda x: x and x.startswith('magnet:'))
            magnet_link = magnet_a['href'] if magnet_a else "None"
            
            results.append({
                "title": title,
                "size": size,
                "date": date,
                "files": files,
                "seeds": seeds,
                "leeches": leeches,
                "magnet": magnet_link,
                "details_url": details_url
            })
            
        return results
    except Exception as e:
        print(f"An error occurred: {e}")
        return []
if __name__ == "__main__":
    query = "money road s02 ita"
    if len(sys.argv) > 1:
        query = " ".join(sys.argv[1:])
        
    results = scrape_dhtindex(query)
    
    # Save all results to JSON
    import json
    with open("results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=4, ensure_ascii=False)
    print("All results saved to results.json")
    
    print(f"\nShowing first 5 of {len(results)} results:")
    for idx, res in enumerate(results[:5], start=1):
        print("-" * 80)
        print(f"{idx}. {res['title']}")
        print(f"   Size: {res['size']} | Date: {res['date']} | Files: {res['files']}")
        print(f"   Seeds: {res['seeds']} | Leeches: {res['leeches']}")
        print(f"   Details: {res['details_url']}")
        print(f"   Magnet: {res['magnet']}")
    print("-" * 80)
