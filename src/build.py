import re
t=open(__import__('os').path.join(__import__('os').path.dirname(__file__),'template.html')).read()
p=open('parser.js').read(); a=open('analysis.js').read()
t=t.replace('__PARSER__',p).replace('__ANALYSIS__',a)
open('index.html','w').write(t)
print(len(t))
